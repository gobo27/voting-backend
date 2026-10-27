
"use strict";

const pool = require("../../../config/db");

// Philippine local time stored as MySQL DATETIME.
// All schedule comparisons use UTC + 08:00.
const PH_NOW_SQL = "(UTC_TIMESTAMP() + INTERVAL 8 HOUR)";

function validId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0;
}

function serverError(res, label, error) {
    console.error(label, error);

    return res.status(500).json({
        message: "Internal server error"
    });
}

function isCompleted(election) {
    return election.status === "completed";
}

function isActive(election) {
    return election.status === "active";
}

function parseSchedule(value) {
    if (typeof value !== "string") return null;

    const match = value.match(
        /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
    );

    if (!match) return null;

    const [, y, mo, d, h, mi, s = "00"] = match;

    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h);
    const minute = Number(mi);
    const second = Number(s);

    const date = new Date(Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
        second
    ));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() + 1 !== month ||
        date.getUTCDate() !== day ||
        date.getUTCHours() !== hour ||
        date.getUTCMinutes() !== minute ||
        date.getUTCSeconds() !== second
    ) {
        return null;
    }

    return {
        value: `${y}-${mo}-${d} ${h}:${mi}:${s}`,
        comparable: date.getTime()
    };
}

async function resolveElection(value) {
    let rows;

    if (value === "current") {
        [rows] = await pool.execute(
            `SELECT *
             FROM elections
             WHERE is_current = 1
               AND archived_at IS NULL
             LIMIT 1`
        );
    } else {
        if (!validId(value)) return null;

        [rows] = await pool.execute(
            `SELECT *
             FROM elections
             WHERE election_id = ?
             LIMIT 1`,
            [Number(value)]
        );
    }

    return rows[0] || null;
}

async function getCurrentTime(db) {
    const [[row]] = await db.query(
        `SELECT
            ${PH_NOW_SQL} AS ph_now`
    );

    return row.ph_now;
}

function toComparable(value) {
    if (value instanceof Date) {
        return value.getTime();
    }

    const parsed = parseSchedule(String(value || ""));
    return parsed ? parsed.comparable : NaN;
}

function scheduleState(election, phNow) {
    if (!election.start_time || !election.end_time) {
        return "UNSCHEDULED";
    }

    const now = toComparable(phNow);
    const start = toComparable(election.start_time);
    const end = toComparable(election.end_time);

    if (![now, start, end].every(Number.isFinite)) {
        return "INVALID";
    }

    if (now < start) return "UPCOMING";
    if (now >= end) return "ENDED";

    return "IN_WINDOW";
}

function votingOpen(election, phNow) {
    return (
        isActive(election) &&
        scheduleState(election, phNow) === "IN_WINDOW" &&
        !election.voting_closed_at &&
        !election.archived_at
    );
}

function scanningOpen(election) {
    return (
        Boolean(election.scanning_open) &&
        !election.scanning_closed_at &&
        !election.archived_at
    );
}

// Lock current election row for every lifecycle change.
// OMR transactions must lock this same row before
// checking scanning_open and counting a ballot.
async function withCurrentElection(requestedId, callback) {
    const db = await pool.getConnection();
    let transactionStarted = false;

    try {
        await db.beginTransaction();
        transactionStarted = true;

        const [rows] = await db.execute(
            `SELECT *
             FROM elections
             WHERE is_current = 1
               AND archived_at IS NULL
             LIMIT 1
             FOR UPDATE`
        );

        const election = rows[0];

        if (!election) {
            await db.rollback();
            transactionStarted = false;

            return {
                status: 409,
                body: {
                    message: "No current election available."
                }
            };
        }

        if (
            requestedId !== "current" &&
            Number(requestedId) !== Number(election.election_id)
        ) {
            await db.rollback();
            transactionStarted = false;

            return {
                status: 409,
                body: {
                    message:
                        "This is not the current election. Refresh the page."
                }
            };
        }

        const phNow = await getCurrentTime(db);
        const result = await callback(db, election, phNow);

        if (result.status >= 400) {
            await db.rollback();
        } else {
            await db.commit();
        }

        transactionStarted = false;
        return result;

    } catch (error) {
        if (transactionStarted) {
            try {
                await db.rollback();
            } catch (rollbackError) {
                console.error("Rollback error:", rollbackError);
            }
        }

        throw error;

    } finally {
        db.release();
    }
}


// GET ELECTION STATUS

exports.getStatus = async (req, res) => {
    let db;

    try {
        const election = await resolveElection(
            req.params.election_id
        );

        if (!election) {
            return res.status(404).json({
                message: "Election not found"
            });
        }

        db = await pool.getConnection();
        const phNow = await getCurrentTime(db);

        return res.json({
            election: {
                election_id: election.election_id,
                title: election.title,
                start_time: election.start_time,
                end_time: election.end_time,
                status: election.status,
                is_active: election.is_active,
                mask_names: election.mask_names,
                is_current: election.is_current,
                archived_at: election.archived_at,
                scanning_open: Boolean(election.scanning_open),
                voting_closed_at: election.voting_closed_at,
                scanning_closed_at: election.scanning_closed_at,
                schedule_state: scheduleState(election, phNow),
                voting_open: votingOpen(election, phNow),
                counting_open: scanningOpen(election)
            }
        });

    } catch (error) {
        return serverError(res, "Get election status:", error);

    } finally {
        if (db) db.release();
    }
};


// PUBLIC CANDIDATES

exports.getPublicCandidates = async (req, res) => {
    try {
        const election = await resolveElection(
            req.params.election_id
        );

        if (!election) {
            return res.status(404).json({
                message: "Election not found"
            });
        }

        const maskNames = Boolean(election.mask_names);

        const [rows] = await pool.execute(
            `SELECT
                c.candidate_id,
                c.name,
                c.course,
                c.grade_level,
                c.party_list,
                c.position_id,
                c.display_order,
                p.title AS position_title
             FROM candidates c
             JOIN positions p
               ON p.position_id = c.position_id
              AND p.election_id = c.election_id
             WHERE c.election_id = ?
             ORDER BY
                p.display_order,
                c.display_order,
                c.candidate_id`,
            [election.election_id]
        );

        return res.json({
            mask_names: maskNames,
            candidates: rows.map(candidate => ({
                ...candidate,
                name: maskNames
                    ? `Candidate #${candidate.candidate_id}`
                    : candidate.name
            }))
        });

    } catch (error) {
        return serverError(
            res,
            "Get public candidates:",
            error
        );
    }
};


// SET SCHEDULE

exports.setSchedule = async (req, res) => {
    const start = parseSchedule(req.body?.start_time);
    const end = parseSchedule(req.body?.end_time);

    if (
        !start ||
        !end ||
        start.comparable >= end.comparable
    ) {
        return res.status(400).json({
            message:
                "Enter valid Philippine start/end times. End must be later."
        });
    }

    try {
        const result = await withCurrentElection(
            req.params.election_id,
            async (db, election, phNow) => {
                if (
                    isActive(election) ||
                    isCompleted(election) ||
                    election.scanning_open
                ) {
                    return {
                        status: 409,
                        body: {
                            message:
                                "Schedule cannot change after voting starts."
                        }
                    };
                }

                if (
                    start.comparable <= toComparable(phNow)
                ) {
                    return {
                        status: 400,
                        body: {
                            message:
                                "Start time must be in the future."
                        }
                    };
                }

                await db.execute(
                    `UPDATE elections
                     SET start_time = ?,
                         end_time = ?
                     WHERE election_id = ?`,
                    [
                        start.value,
                        end.value,
                        election.election_id
                    ]
                );

                return {
                    status: 200,
                    body: {
                        message: "Election schedule updated.",
                        start_time: start.value,
                        end_time: end.value
                    }
                };
            }
        );

        return res.status(result.status).json(result.body);

    } catch (error) {
        return serverError(res, "Set schedule:", error);
    }
};


// START ELECTION

exports.startElection = async (req, res) => {
    try {
        const result = await withCurrentElection(
            req.params.election_id,
            async (db, election, phNow) => {
                if (isCompleted(election)) {
                    return {
                        status: 409,
                        body: {
                            message: "Voting has already ended."
                        }
                    };
                }

                if (isActive(election)) {
                    return {
                        status: 200,
                        body: {
                            message: "Election is already active.",
                            voting_open: votingOpen(election, phNow)
                        }
                    };
                }

                const schedule = scheduleState(election, phNow);

                if (schedule === "UNSCHEDULED" ||
                    schedule === "INVALID") {
                    return {
                        status: 409,
                        body: {
                            message: "Save a valid schedule first."
                        }
                    };
                }

                if (schedule === "ENDED") {
                    return {
                        status: 409,
                        body: {
                            message: "Scheduled voting time has ended."
                        }
                    };
                }

                await db.execute(
                    `UPDATE elections
                     SET status = 'active',
                         is_active = 1,
                         scanning_open = 1,
                         scanning_closed_at = NULL
                     WHERE election_id = ?`,
                    [election.election_id]
                );

                return {
                    status: 200,
                    body: {
                        message: schedule === "UPCOMING"
                            ? "Election activated. Voting opens at the scheduled time."
                            : "Election started.",
                        voting_open: schedule === "IN_WINDOW",
                        counting_open: true
                    }
                };
            }
        );

        return res.status(result.status).json(result.body);

    } catch (error) {
        return serverError(res, "Start election:", error);
    }
};


// STOP VOTING

exports.stopVoting = async (req, res) => {
    try {
        const result = await withCurrentElection(
            req.params.election_id,
            async (db, election) => {
                if (!isActive(election)) {
                    return {
                        status: 409,
                        body: {
                            message: "Only an active election can be stopped."
                        }
                    };
                }

                await db.execute(
                    `UPDATE elections
                     SET status = 'completed',
                         is_active = 0,
                         voting_closed_at = ${PH_NOW_SQL},
                         scanning_open = 1
                     WHERE election_id = ?`,
                    [election.election_id]
                );

                return {
                    status: 200,
                    body: {
                        message:
                            "Voting closed. Committee scanning remains open.",
                        voting_open: false,
                        counting_open: true
                    }
                };
            }
        );

        return res.status(result.status).json(result.body);

    } catch (error) {
        return serverError(res, "Stop voting:", error);
    }
};


// FINISH SCANNING

exports.finishScanning = async (req, res) => {
    try {
        const result = await withCurrentElection(
            req.params.election_id,
            async (db, election, phNow) => {
                if (!scanningOpen(election)) {
                    return {
                        status: 409,
                        body: {
                            message:
                                "Scanning is already closed or was never opened."
                        }
                    };
                }

                if (
                    isActive(election) &&
                    scheduleState(election, phNow) !== "ENDED"
                ) {
                    return {
                        status: 409,
                        body: {
                            message:
                                "Close voting or wait for the scheduled end before finishing scanning."
                        }
                    };
                }

                const [pending] = await db.execute(
                    `SELECT COUNT(*) AS total
                     FROM issued_ballots
                     WHERE election_id = ?
                       AND status = 'CAST'`,
                    [election.election_id]
                );

                if (Number(pending[0].total) > 0) {
                    return {
                        status: 409,
                        body: {
                            message:
                                `${pending[0].total} received ballot(s) are not yet counted.`
                        }
                    };
                }

                await db.execute(
                    `UPDATE elections
                     SET status = 'completed',
                         is_active = 0,
                         scanning_open = 0,
                         voting_closed_at = COALESCE(
                             voting_closed_at,
                             ${PH_NOW_SQL}
                         ),
                         scanning_closed_at = ${PH_NOW_SQL}
                     WHERE election_id = ?`,
                    [election.election_id]
                );

                return {
                    status: 200,
                    body: {
                        message:
                            "Scanning finished. Counting is locked.",
                        counting_open: false,
                        archive_ready: true
                    }
                };
            }
        );

        return res.status(result.status).json(result.body);

    } catch (error) {
        return serverError(res, "Finish scanning:", error);
    }
};


// COUNTING STATUS

exports.getCountingStatus = async (req, res) => {
    let db;

    try {
        const election = await resolveElection(
            req.params.election_id
        );

        if (!election) {
            return res.status(404).json({
                message: "Election not found"
            });
        }

        db = await pool.getConnection();

        const phNow = await getCurrentTime(db);

        const [rows] = await db.execute(
            `SELECT
                status,
                COUNT(*) AS total
             FROM issued_ballots
             WHERE election_id = ?
             GROUP BY status`,
            [election.election_id]
        );

        const totals = {
            ISSUED: 0,
            CAST: 0,
            COUNTED: 0,
            VOID: 0
        };

        for (const row of rows) {
            totals[row.status] = Number(row.total);
        }

        return res.json({
            election_id: election.election_id,
            voting_open: votingOpen(election, phNow),
            scanning_open: scanningOpen(election),
            schedule_state: scheduleState(election, phNow),
            archive_ready:
                !scanningOpen(election) &&
                isCompleted(election) &&
                totals.CAST === 0,
            ballots: totals
        });

    } catch (error) {
        return serverError(res, "Counting status:", error);

    } finally {
        if (db) db.release();
    }
};


// MASK NAMES

exports.toggleMaskNames = async (req, res) => {
    try {
        const result = await withCurrentElection(
            req.params.election_id,
            async (db, election) => {
                const newValue = election.mask_names ? 0 : 1;

                await db.execute(
                    `UPDATE elections
                     SET mask_names = ?
                     WHERE election_id = ?`,
                    [newValue, election.election_id]
                );

                return {
                    status: 200,
                    body: {
                        message: "Mask names updated.",
                        mask_names: Boolean(newValue)
                    }
                };
            }
        );
        return res.status(result.status).json(result.body);

    } catch (error) {
        return serverError(res, "Toggle mask names:", error);
    }
};
