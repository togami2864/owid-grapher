import * as React from "react"
import * as ReactDOM from "react-dom"
import { observer } from "mobx-react"
import { observable, computed } from "mobx"
import { csvParse, timeFormat } from "d3"

import {
    fetchText,
    sortBy,
    formatValue,
    maxBy,
    groupBy,
    entries
} from "charts/Util"

interface CovidDatum {
    date: Date
    location: string
    total_cases: number
    total_deaths: number // can contain NaN
    new_cases: number // can contain NaN
    new_deaths: number // can contain NaN
}

type CovidSeries = CovidDatum[]

interface CovidDoublingRange {
    latestDay: CovidDatum
    halfDay: CovidDatum
    length: number | undefined
}

interface CovidCountryDatum {
    id: string
    location: string
    series: CovidSeries
    latest: CovidDatum | undefined
    caseDoublingRange: CovidDoublingRange | undefined
}

type CovidCountrySeries = CovidCountryDatum[]

interface CovidTableProps {
    preloadData?: CovidSeries
}

const DATA_URL = "https://cowid.netlify.com/data/full_data.csv"
const MS_PER_DAY = 1000 * 60 * 60 * 24

// From https://stackoverflow.com/a/15289883
function dateDiffInDays(a: Date, b: Date) {
    // Discard the time and time-zone information.
    const utca = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
    const utcb = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
    return Math.floor((utca - utcb) / MS_PER_DAY)
}

function getDoublingRange(
    series: CovidSeries,
    accessor: (d: CovidDatum) => number
): CovidDoublingRange | undefined {
    if (series.length > 1) {
        const latestDay = maxBy(series, d => d.date) as CovidDatum
        const latestValue = accessor(latestDay)
        const halfDay = maxBy(
            series.filter(d => accessor(d) <= latestValue / 2),
            d => d.date
        )
        if (halfDay !== undefined) {
            return {
                latestDay,
                halfDay,
                length: dateDiffInDays(latestDay.date, halfDay.date)
            }
        } else {
            return undefined
        }
    }
    return undefined
}

@observer
export class CovidTable extends React.Component<CovidTableProps> {
    @observable.ref data: CovidSeries | undefined =
        this.props.preloadData ?? undefined

    @observable.ref isLoaded: boolean = !!this.props.preloadData
    @observable.ref isLoading: boolean = false
    @observable.ref error: string | undefined = undefined

    componentDidMount() {
        if (!this.props.preloadData) {
            this.loadData()
        }
    }

    async loadData() {
        this.isLoading = true
        try {
            const responseText = await fetchText(DATA_URL)
            const rows: CovidSeries = csvParse(responseText).map(row => {
                return {
                    date: new Date(row.date as string),
                    location: row.location as string,
                    total_cases: parseInt(row.total_cases as string),
                    total_deaths: parseInt(row.total_deaths as string),
                    new_cases: parseInt(row.new_cases as string),
                    new_deaths: parseInt(row.new_deaths as string)
                }
            })
            this.data = rows
            this.isLoaded = true
            this.error = undefined
        } catch (error) {
            this.error = error && error.message
        }
        this.isLoading = false
    }

    @computed get byLocation(): CovidCountrySeries {
        if (this.data) {
            return entries(groupBy(this.data, d => d.location)).map(
                ([location, series]) => {
                    const sortedSeries: CovidSeries = sortBy(
                        series,
                        d => d.date
                    )
                    return {
                        id: location,
                        location: location,
                        series: sortedSeries,
                        latest: maxBy(series, d => d.date),
                        caseDoublingRange: getDoublingRange(
                            sortedSeries,
                            d => d.total_cases
                        )
                    }
                }
            )
        }
        return []
    }

    render() {
        if (this.isLoading) {
            return <div className="covid-loading"></div>
        }
        if (this.error) {
            return (
                <div className="covid-error">
                    There was an error loading the live table.
                </div>
            )
        }
        return (
            <div className="covid-table-container">
                <table className="covid-table">
                    <thead>
                        <tr>
                            <th className="location">Location</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {this.byLocation
                            .filter(d =>
                                d.latest ? d.latest.total_cases >= 20 : false
                            )
                            .map(datum => (
                                <CovidTableRow key={datum.id} datum={datum} />
                            ))}
                    </tbody>
                </table>
                <div className="covid-table-source">
                    <p>
                        Source:{" "}
                        <a href="https://www.who.int/emergencies/diseases/novel-coronavirus-2019/situation-reports/">
                            WHO
                        </a>
                        . Download the <a href={DATA_URL}>full dataset</a>.
                    </p>
                </div>
            </div>
        )
    }
}

interface CovidTableRowProps {
    datum: CovidCountryDatum
}

function formatInt(n: number | undefined, defaultValue: string = ""): string {
    return n === undefined || isNaN(n) ? defaultValue : formatValue(n, {})
}

const defaultTimeFormat = timeFormat("%e %B")

function formatDate(date: Date): string {
    return defaultTimeFormat(date)
}

export class CovidTableRow extends React.Component<CovidTableRowProps> {
    render() {
        const d = this.props.datum
        return (
            <tr>
                <td className="location">{d.location}</td>
                {/* <td>{formatInt(d.latest?.total_cases, "0")}</td>
                <td>{formatInt(d.latest?.total_deaths, "0")}</td>
                <td>{formatInt(d.daysPerDoubling, "")}</td> */}
                <td className="daysPerDoubling">
                    {d.caseDoublingRange !== undefined ? (
                        <>
                            <p>
                                Confirmed cases have doubled in the last{" "}
                                <strong>
                                    {formatInt(d.caseDoublingRange.length, "")}{" "}
                                    days
                                </strong>
                            </p>
                            <p className="faint">
                                From{" "}
                                <strong>
                                    {formatInt(
                                        d.caseDoublingRange.halfDay.total_cases
                                    )}
                                </strong>{" "}
                                cases on{" "}
                                {formatDate(d.caseDoublingRange.halfDay.date)}{" "}
                                to{" "}
                                <strong>
                                    {formatInt(
                                        d.caseDoublingRange.latestDay
                                            .total_cases
                                    )}
                                </strong>{" "}
                                cases on{" "}
                                {formatDate(d.caseDoublingRange.latestDay.date)}
                            </p>
                        </>
                    ) : (
                        <span className="no-data">
                            Not enough data available yet
                        </span>
                    )}
                </td>
            </tr>
        )
    }
}

export function runCovid() {
    const element = document.getElementById("covid-table-embed")
    if (element) {
        ReactDOM.render(<CovidTable />, element)
    }
}