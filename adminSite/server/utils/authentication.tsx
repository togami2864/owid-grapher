import * as express from "express"
import * as crypto from "crypto"
import * as randomstring from "randomstring"
import { User } from "db/model/User"
import { BCryptHasher } from "utils/hashers"

import * as db from "db/db"
import { CLOUDFLARE_AUD, SECRET_KEY, SESSION_COOKIE_AGE } from "serverSettings"
import { JsonError } from "utils/server/serverUtil"
import fetch from "node-fetch"
import { verify } from "jsonwebtoken"
import { ENV } from "settings"

export type CurrentUser = User

export type Request = express.Request

export interface Response extends express.Response {
    locals: { user: CurrentUser; session: Session }
}

interface Session {
    id: string
    expiryDate: Date
}

export async function authCloudflareSSOMiddleware(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) {
    // Get token stored in the CF_Authorization cookie
    const jwt = req.cookies["CF_Authorization"]

    // If the cookie is present, it means that route is being protected by
    // Cloudflare Access. We try and validate the JWT it contains to sign-in the
    // user automatically, through SSO.
    if (jwt !== undefined) {
        // Get the Cloudflare public key
        const certsUrl =
            "https://owid.cloudflareaccess.com/cdn-cgi/access/certs"
        const response = await fetch(certsUrl)
        const certs = await response.json()
        const publicCert = certs.public_cert.cert
        const audTag = CLOUDFLARE_AUD

        // Verify the JWT token
        verify(
            jwt,
            publicCert,
            { audience: audTag, algorithms: ["RS256"] },
            async (err: any, payload: any) => {
                if (!err) {
                    console.log("Token successfully verified.")
                    const user = await User.findOne({ email: payload.email })
                    // If ok then authenticate as the user stored in the token
                    if (user) {
                        const { id: sessionId } = await logInAsUser(user)
                        res.cookie("sessionid", sessionId, {
                            httpOnly: true,
                            sameSite: "lax",
                            secure: ENV === "production",
                        })
                        return res.redirect("/admin")
                    } else {
                        return next("User not found.")
                    }
                } else {
                    // Token not verified
                    console.log("Token not verified.")
                    logOut(req, res, next)
                }
            }
        )
    } else {
        return next()
    }
}

export async function logOut(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) {
    if (res.locals.user)
        await db.query(`DELETE FROM sessions WHERE session_key = ?`, [
            res.locals.session.id,
        ])

    res.clearCookie("sessionid")
    res.clearCookie("CF_Authorization")
    return res.redirect("/admin")
}

export async function authMiddleware(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) {
    let user: CurrentUser | undefined
    let session: Session | undefined

    const sessionid = req.cookies["sessionid"]
    if (sessionid) {
        // Expire old sessions
        await db.execute("DELETE FROM sessions WHERE expire_date < NOW()")

        const rows = await db.query(
            `SELECT * FROM sessions WHERE session_key = ?`,
            [sessionid]
        )
        if (rows.length) {
            const sessionData = Buffer.from(
                rows[0].session_data,
                "base64"
            ).toString("utf8")
            const sessionJson = JSON.parse(
                sessionData.split(":").slice(1).join(":")
            )

            user = await User.findOne({ email: sessionJson.user_email })
            if (!user)
                throw new JsonError("Invalid session (no such user)", 500)
            session = { id: sessionid, expiryDate: rows[0].expiry_date }

            // Don't await this
            user.lastSeen = new Date()
            user.save()
        }
    }

    // Authed urls shouldn't be cached
    res.set("Cache-Control", "public, max-age=0, must-revalidate")

    if (user && user.isActive) {
        res.locals.session = session
        res.locals.user = user
        return next()
    } else if (
        !req.path.startsWith("/admin") ||
        req.path === "/admin/login" ||
        req.path === "/admin/register"
    ) {
        return next()
    } else {
        return res.redirect(`/admin/login?next=${req.path}`)
    }
}

function saltedHmac(salt: string, value: string): string {
    const hmac = crypto.createHmac("sha1", salt + SECRET_KEY)
    hmac.update(value)
    return hmac.digest("hex")
}

async function logInAsUser(user: User) {
    const sessionId = randomstring.generate()

    const sessionJson = JSON.stringify({
        user_email: user.email,
    })
    const sessionHash = saltedHmac(
        "django.contrib.sessions.SessionStore",
        sessionJson
    )
    const sessionData = Buffer.from(`${sessionHash}:${sessionJson}`).toString(
        "base64"
    )

    const now = new Date()
    const expiryDate = new Date(now.getTime() + 1000 * SESSION_COOKIE_AGE)

    await db.execute(
        `INSERT INTO sessions (session_key, session_data, expire_date) VALUES (?, ?, ?)`,
        [sessionId, sessionData, expiryDate]
    )

    user.lastLogin = now
    await user.save()

    return { id: sessionId, expiryDate: expiryDate }
}

export async function logInWithCredentials(
    email: string,
    password: string
): Promise<Session> {
    const user = await User.findOne({ email: email })
    if (!user) {
        throw new Error("No such user")
    }

    const h = new BCryptHasher()
    if (await h.verify(password, user.password)) {
        // Login successful
        return logInAsUser(user)
    } else {
        throw new Error("Invalid password")
    }
}
