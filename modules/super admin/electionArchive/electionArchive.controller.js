
"use strict";

const db = require("../../../config/db");

const PH_NOW_SQL = "(UTC_TIMESTAMP() + INTERVAL 8 HOUR)";

const VALID_SCHOOL_LEVELS = [
    "elementary",
    "highschool",
    "college"
];

// Default scanner scopes para sa bawat bagong election.
const SCHOOL_SCOPES = {
    elementary: [
        ["grade", "3", "Grade 3"],
        ["grade", "4", "Grade 4"],
        ["grade", "5", "Grade 5"],
        ["grade", "6", "Grade 6"]
    ],
    highschool: [
        ["grade", "7", "Grade 7"],
        ["grade", "8", "Grade 8"],
        ["grade", "9", "Grade 9"],
        ["grade", "10", "Grade 10"],
        ["grade", "11", "Grade 11"],
        ["grade", "12", "Grade 12"]
    ],
    college: [
        ["department", "BSCS", "BSCS"],
        ["department", "BSCOE", "BSCoe"],
        ["department", "BSN", "BSN"],
        ["department", "BSA", "BSA"],
        ["department", "BSBA", "BSBA"],
        ["department", "BSED", "BSED"],
        ["department", "BSTM", "BSTM"],
        ["department", "BSHM", "BSHM"],
        ["department", "BSPSYCH", "BSPsych"]
    ]
};

function validId(value) {
    return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function fail(res, error) {
    console.error("Election archive:", error);

    return res.status(500).json({
        message: "Database operation failed"
    });
}

function normalizeSchoolLevel(value) {
    return String(value || "college").trim().toLowerCase();
}

// Safe transaction para walang sabay na election creation/archive
async function lockedTransaction(callback) {
    const conn = await db.getConnection();
    let locked = false;
    let started = false;

    try {
        const [[result]] = await conn.query(
            "SELECT GET_LOCK('campusvote_election_cycle', 10) AS acquired"
        );

        if (result.acquired !== 1) {
            throw new Error("Election management is busy. Please retry.");
        }

        locked = true;

        await conn.beginTransaction();
        started = true;

        const output = await callback(conn);

        if (output && output.code >= 400) {
            await conn.rollback();
        } else {
            await conn.commit();
        }

        started = false;
        return output;

    } catch (error) {
        if (started) {
            try {
                await conn.rollback();
            } catch (e) {
                console.error("Rollback failed:", e);
            }
        }

        throw error;

    } finally {
        if (locked) {
            try {
                await conn.query(
                    "SELECT RELEASE_LOCK('campusvote_election_cycle')"
                );
            } catch (e) {
                console.error("Release lock failed:", e);
            }
        }

        conn.release();
    }
}

// Kunin lahat ng elections kasama ang school level
exports.list = async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT
                e.election_id,
                e.title,
                e.school_level,
                e.start_time,
                e.end_time,
                e.status,
                e.is_active,
                e.is_current,
                e.archived_at,
                e.scanning_open,
                e.scanning_closed_at,

                (
                    SELECT COUNT(*)
                    FROM positions p
                    WHERE p.election_id = e.election_id
                ) AS positions_count,

                (
                    SELECT COUNT(*)
                    FROM candidates c
                    WHERE c.election_id = e.election_id
                ) AS candidates_count,

                (
                    SELECT COUNT(*)
                    FROM scanned_ballots s
                    WHERE s.election_id = e.election_id
                ) AS scanned_ballots_count

            FROM elections e
            ORDER BY e.election_id DESC
        `);

        return res.json({
            elections: rows
        });

    } catch (error) {
        return fail(res, error);
    }
};

// Read-only election details
exports.details = async (req, res) => {
    const electionId = Number(req.params.id);

    if (!validId(electionId)) {
        return res.status(400).json({
            message: "Invalid election ID"
        });
    }

    try {
        const [elections] = await db.execute(
            `SELECT
                election_id,
                title,
                school_level,
                start_time,
                end_time,
                status,
                is_current,
                archived_at,
                voting_closed_at,
                scanning_closed_at
             FROM elections
             WHERE election_id = ?
             LIMIT 1`,
            [electionId]
        );

        if (!elections.length) {
            return res.status(404).json({
                message: "Election not found"
            });
        }

        const [positions] = await db.execute(
            `SELECT
                position_id,
                title,
                max_selection,
                display_order
             FROM positions
             WHERE election_id = ?
             ORDER BY display_order, position_id`,
            [electionId]
        );

        const [candidates] = await db.execute(
            `SELECT
                candidate_id,
                position_id,
                name,
                course,
                grade_level,
                party_list
             FROM candidates
             WHERE election_id = ?
             ORDER BY position_id, display_order, candidate_id`,
            [electionId]
        );

        const [templates] = await db.execute(
            `SELECT
                template_id,
                template_name,
                paper_size
             FROM ballot_templates
             WHERE election_id = ?
             ORDER BY template_id`,
            [electionId]
        );

        const [ballots] = await db.execute(
            `SELECT status, COUNT(*) AS total
             FROM issued_ballots
             WHERE election_id = ?
             GROUP BY status`,
            [electionId]
        );

        const [votes] = await db.execute(
            `SELECT
                v.position_id,
                v.candidate_id,
                COUNT(*) AS total_votes
             FROM ballot_votes v
             JOIN issued_ballots b
                ON b.ballot_id = v.ballot_id
             WHERE b.election_id = ?
               AND b.status = 'COUNTED'
             GROUP BY v.position_id, v.candidate_id`,
            [electionId]
        );

        const [scans] = await db.execute(
            `SELECT COUNT(*) AS total
             FROM scanned_ballots
             WHERE election_id = ?`,
            [electionId]
        );

        return res.json({
            election: elections[0],
            positions,
            candidates,
            templates,
            ballot_status_counts: ballots,
            recorded_votes: votes,
            scanned_ballots_count: Number(scans[0].total),
            note: "Read-only historical data from saved database records."
        });

    } catch (error) {
        return fail(res, error);
    }
};

// Archive election nang hindi binubura ang historical records
exports.archive = async (req, res) => {
    const electionId = Number(req.params.id);

    if (!validId(electionId)) {
        return res.status(400).json({
            message: "Invalid election ID"
        });
    }

    try {
        const result = await lockedTransaction(async conn => {
            const [rows] = await conn.execute(
                `SELECT
                    election_id,
                    status,
                    is_current,
                    archived_at,
                    voting_closed_at,
                    scanning_open,
                    scanning_closed_at
                 FROM elections
                 WHERE election_id = ?
                 FOR UPDATE`,
                [electionId]
            );

            if (!rows.length) {
                return {
                    code: 404,
                    message: "Election not found"
                };
            }

            const election = rows[0];

            if (election.archived_at) {
                return {
                    code: 409,
                    message: "Election already archived"
                };
            }

            if (election.status !== "completed") {
                return {
                    code: 409,
                    message: "Stop voting before archiving this election"
                };
            }

            if (!election.voting_closed_at) {
                return {
                    code: 409,
                    message: "Voting must be closed before archiving."
                };
            }

            if (Number(election.scanning_open) !== 0) {
                return {
                    code: 409,
                    message: "Finish scanning before archiving."
                };
            }

            if (!election.scanning_closed_at) {
                return {
                    code: 409,
                    message: "Finish Scanning has not been completed yet."
                };
            }

            const [pending] = await conn.execute(
                `SELECT COUNT(*) AS total
                 FROM issued_ballots
                 WHERE election_id = ?
                   AND status = 'CAST'`,
                [electionId]
            );

            const pendingCount = Number(pending[0].total);

            if (pendingCount > 0) {
                return {
                    code: 409,
                    message:
                        `${pendingCount} received ballot(s) are not yet counted.`
                };
            }

            await conn.execute(
                `UPDATE elections
                 SET archived_at = ${PH_NOW_SQL},
                     is_current = 0,
                     is_active = 0
                 WHERE election_id = ?`,
                [electionId]
            );

            return {
                code: 200,
                message: "Election archived. Historical data preserved.",
                election_id: electionId,
                archived: true
            };
        });

        return res.status(result.code).json(result);

    } catch (error) {
        return fail(res, error);
    }
};
exports.downloadPdf = async (req, res) => {
    const electionId = Number(req.params.id);

    if (!validId(electionId)) {
        return res.status(400).json({
            message: "Invalid election ID"
        });
    }

    try {
        const {
            fetchReportData,
            createPdf
        } = require("./electionReport.service");

        const data = await fetchReportData(electionId);

        if (!data) {
            return res.status(404).json({
                message: "Election not found"
            });
        }

        const pdfBuffer = await createPdf(data);

        res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition":
                `attachment; filename="election-report-${electionId}.pdf"`,
            "Content-Length": String(pdfBuffer.length),
            "Cache-Control": "no-store"
        });

        return res.send(pdfBuffer);

    } catch (error) {
        console.error("PDF REPORT ERROR:", error);

        if (!res.headersSent) {
            return res.status(500).json({
                message: "Unable to generate election PDF report."
            });
        }
    }
};
const reportJwt = require("jsonwebtoken");

const {
    sendElectionReportEmail
} = require("../adduser/emailjs.server");

function reportError(res, error) {
    console.error("ELECTION REPORT ERROR:", error);

    return res.status(error.status || 500).json({
        message: error.status
            ? error.message
            : "Unable to process election report request."
    });
}

// Get Advisers assigned to an election
exports.reportAdvisers = async (req, res) => {
    const electionId = Number(req.params.id);

    if (!validId(electionId)) {
        return res.status(400).json({
            message: "Invalid election ID."
        });
    }

    try {
        const [advisers] = await db.execute(
            `SELECT DISTINCT
                u.id,
                u.name,
                u.email
             FROM election_adviser_assignments a
             JOIN users u
               ON u.id = a.adviser_user_id
             WHERE a.election_id = ?
               AND a.is_active = 1
               AND u.role = 'adviser'
             ORDER BY u.name, u.id`,
            [electionId]
        );

        return res.json({ advisers });

    } catch (error) {
        return reportError(res, error);
    }
};

// Send secure PDF links to selected Advisers
exports.notifyReportAdvisers = async (req, res) => {
    const electionId = Number(req.params.id);
    const adviserIds = req.body?.adviser_ids;

    if (!validId(electionId)) {
        return res.status(400).json({
            message: "Invalid election ID."
        });
    }

    if (
        !Array.isArray(adviserIds) ||
        adviserIds.length < 1 ||
        adviserIds.length > 20 ||
        adviserIds.some(id => !validId(id)) ||
        new Set(adviserIds.map(Number)).size !== adviserIds.length
    ) {
        return res.status(400).json({
            message: "Select 1 to 20 unique Adviser IDs."
        });
    }

    const secret = process.env.REPORT_LINK_SECRET;
    const apiBase = process.env.REPORT_PUBLIC_API_BASE;

    console.log("REPORT CONFIG CHECK:", {
        secretExists: Boolean(secret),
        secretLength: Buffer.byteLength(secret || "", "utf8"),
        apiBaseExists: Boolean(apiBase),
        httpsValid: Boolean(apiBase?.startsWith("https://"))
    });


    if (
        !secret ||
        Buffer.byteLength(secret, "utf8") < 32 ||
        !apiBase ||
        !apiBase.startsWith("https://")
    ) {
        return res.status(503).json({
            message: "Secure report link is not configured."
        });
    }

    try {
        const [elections] = await db.execute(
            `SELECT election_id, title, school_level,
                    status, archived_at,
                    voting_closed_at, scanning_open,
                    scanning_closed_at
             FROM elections
             WHERE election_id = ?
             LIMIT 1`,
            [electionId]
        );

        const election = elections[0];

        if (!election) {
            return res.status(404).json({
                message: "Election not found."
            });
        }

        if (
            election.archived_at ||
            election.status !== "completed" ||
            !election.voting_closed_at ||
            Number(election.scanning_open) !== 0 ||
            !election.scanning_closed_at
        ) {
            return res.status(409).json({
                message:
                    "Finish voting and scanning before sending the report."
            });
        }

        const [pending] = await db.execute(
            `SELECT COUNT(*) AS total
             FROM issued_ballots
             WHERE election_id = ?
               AND status = 'CAST'`,
            [electionId]
        );

        if (Number(pending[0].total) > 0) {
            return res.status(409).json({
                message: "Some received ballots are not yet counted."
            });
        }

        const placeholders = adviserIds.map(() => "?").join(",");

        const [advisers] = await db.query(
            `SELECT DISTINCT u.id, u.name, u.email
             FROM election_adviser_assignments a
             JOIN users u ON u.id = a.adviser_user_id
             WHERE a.election_id = ?
               AND a.is_active = 1
               AND u.role = 'adviser'
               AND u.id IN (${placeholders})`,
            [electionId, ...adviserIds.map(Number)]
        );

        if (advisers.length !== adviserIds.length) {
            return res.status(400).json({
                message:
                    "One or more selected Advisers are not actively assigned."
            });
        }

        const results = [];

        for (const adviser of advisers) {
            try {
                // Signed link valid for 7 days
                const signedToken = reportJwt.sign(
                    {
                        election_id: electionId,
                        adviser_id: adviser.id,
                        purpose: "election_pdf"
                    },
                    secret,
                    {
                        algorithm: "HS256",
                        expiresIn: "7d",
                        issuer: "campusvote",
                        audience: "election-report"
                    }
                );

                const reportUrl =
                    `${apiBase.replace(/\/+$/, "")}` +
                    `/election_archive/report-download` +
                    `?token=${encodeURIComponent(signedToken)}`;

                const sent = await sendElectionReportEmail({
                    to: adviser.email,
                    adviserName: adviser.name,
                    electionTitle: election.title,
                    schoolLevel: election.school_level,
                    reportUrl
                });

                results.push({
                    adviser_id: adviser.id,
                    name: adviser.name,
                    accepted: sent.sent === true
                });

            } catch (error) {
                console.error(
                    "REPORT EMAIL FAILED:",
                    adviser.id,
                    error.message
                );

                results.push({
                    adviser_id: adviser.id,
                    name: adviser.name,
                    accepted: false
                });
            }
        }

        const acceptedCount =
            results.filter(item => item.accepted).length;

        return res.status(
            acceptedCount === advisers.length ? 200 : 207
        ).json({
            message:
                `${acceptedCount} of ${advisers.length} ` +
                "report email requests accepted by EmailJS.",
            accepted_count: acceptedCount,
            total: advisers.length,
            results,
            archived: false
        });

    } catch (error) {
        return reportError(res, error);
    }
};

// Download using a signed expiring link
exports.downloadSignedReport = async (req, res) => {
    const signedToken = String(req.query?.token || "");

    if (!signedToken || signedToken.length > 4096) {
        return res.status(400).json({
            message: "Invalid report link."
        });
    }

    try {
        const secret = process.env.REPORT_LINK_SECRET;

        if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
            return res.status(503).json({
                message: "Report link service unavailable."
            });
        }

        const payload = reportJwt.verify(signedToken, secret, {
            algorithms: ["HS256"],
            issuer: "campusvote",
            audience: "election-report"
        });

        if (
            payload.purpose !== "election_pdf" ||
            !validId(payload.election_id) ||
            !validId(payload.adviser_id)
        ) {
            return res.status(403).json({
                message: "Invalid report authorization."
            });
        }

        // Check that recipient has an assignment record
        const [assignments] = await db.execute(
            `SELECT a.assignment_id
             FROM election_adviser_assignments a
             JOIN users u ON u.id = a.adviser_user_id
             WHERE a.election_id = ?
               AND a.adviser_user_id = ?
               AND u.role = 'adviser'
             LIMIT 1`,
            [payload.election_id, payload.adviser_id]
        );

        if (!assignments.length) {
            return res.status(403).json({
                message: "Report access denied."
            });
        }

        const {
            fetchReportData,
            createPdf
        } = require("./electionReport.service");

        const reportData = await fetchReportData(
            payload.election_id
        );

        if (!reportData) {
            return res.status(404).json({
                message: "Election not found."
            });
        }

        const pdfBuffer = await createPdf(reportData);

        res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition":
                `attachment; filename="election-report-${payload.election_id}.pdf"`,
            "Content-Length": String(pdfBuffer.length),
            "Cache-Control": "no-store, private",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff"
        });

        return res.send(pdfBuffer);

    } catch (error) {
        if (
            error.name === "TokenExpiredError" ||
            error.name === "JsonWebTokenError" ||
            error.name === "NotBeforeError"
        ) {
            return res.status(403).json({
                message: "Report link is invalid or expired."
            });
        }

        return reportError(res, error);
    }
};
// Create election na may school level
exports.create = async (req, res) => {
    const title = String(req.body?.title || "").trim();
    const start = String(req.body?.start_time || "");
    const end = String(req.body?.end_time || "");

    const schoolLevel = normalizeSchoolLevel(
        req.body?.school_level
    );

    const copyId = req.body?.copy_positions_from
        ? Number(req.body.copy_positions_from)
        : null;

    if (!title || title.length > 150) {
        return res.status(400).json({
            message: "Title is required (max 150 characters)"
        });
    }

    // Tatlong school levels lang ang allowed
    if (!VALID_SCHOOL_LEVELS.includes(schoolLevel)) {
        return res.status(400).json({
            message:
                "Invalid school level. Choose elementary, highschool, or college."
        });
    }

    const dateFormat =
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

    if (
        !dateFormat.test(start) ||
        !dateFormat.test(end) ||
        start >= end
    ) {
        return res.status(400).json({
            message: "Invalid start or end date"
        });
    }

    if (copyId !== null && !validId(copyId)) {
        return res.status(400).json({
            message: "Invalid source election ID"
        });
    }

    try {
        const result = await lockedTransaction(async conn => {
            // Isang current election lang ang puwede
            const [current] = await conn.query(
                `SELECT election_id
                 FROM elections
                 WHERE is_current = 1
                 LIMIT 1
                 FOR UPDATE`
            );

            if (current.length) {
                return {
                    code: 409,
                    message:
                        "Archive the current election before creating a new one."
                };
            }

            // I-check ang school level bago mag-copy ng positions
            if (copyId !== null) {
                const [source] = await conn.execute(
                    `SELECT
                        election_id,
                        school_level
                     FROM elections
                     WHERE election_id = ?`,
                    [copyId]
                );

                if (!source.length) {
                    return {
                        code: 404,
                        message: "Source election not found"
                    };
                }

                const sourceSchoolLevel = normalizeSchoolLevel(
                    source[0].school_level
                );

                if (sourceSchoolLevel !== schoolLevel) {
                    return {
                        code: 409,
                        message:
                            "Cannot copy positions from a different school level."
                    };
                }
            }

            // Save ang selected school level sa bagong election
            const [insert] = await conn.execute(
                `INSERT INTO elections
                (
                    title,
                    school_level,
                    start_time,
                    end_time,
                    status,
                    is_active,
                    mask_names,
                    is_current
                )
                VALUES (?, ?, ?, ?, NULL, 0, 0, 1)`,
                [
                    title,
                    schoolLevel,
                    start,
                    end
                ]
            );

            // Isabay ang grade/department scopes sa election transaction.
            const scopes = SCHOOL_SCOPES[schoolLevel];

            for (const [scopeType, scopeCode, scopeName] of scopes) {
                await conn.execute(
                    `INSERT INTO election_scopes
                     (election_id, scope_type, scope_code, scope_name)
                     VALUES (?, ?, ?, ?)`,
                    [insert.insertId, scopeType, scopeCode, scopeName]
                );
            }

            // Positions lang ang kokopyahin, hindi candidates o votes
            if (copyId !== null) {
                await conn.execute(
                    `INSERT INTO positions
                    (
                        election_id,
                        title,
                        max_selection,
                        display_order
                    )
                    SELECT
                        ?,
                        title,
                        max_selection,
                        display_order
                    FROM positions
                    WHERE election_id = ?`,
                    [
                        insert.insertId,
                        copyId
                    ]
                );
            }

            return {
                code: 201,
                message: "New election created",
                election_id: insert.insertId,
                school_level: schoolLevel,
                scopes_created: scopes.length
            };
        });

        return res.status(result.code).json(result);

    } catch (error) {
        return fail(res, error);
    }
};
