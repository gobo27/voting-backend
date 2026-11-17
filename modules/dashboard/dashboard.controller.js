
"use strict";

const connection = require("../../config/db");

// Kunin ang current o selected election
async function resolveElection(electionId) {
    const value = String(electionId ?? "").trim();

    let sql;
    let params = [];

    if (value.toLowerCase() === "current") {
        sql = `
            SELECT
                election_id,
                title,
                school_level,
                start_time,
                end_time,
                status,
                is_active,
                mask_names,
                scanning_open,
                voting_closed_at,
                scanning_closed_at
            FROM elections
            WHERE is_current = 1
              AND archived_at IS NULL
            LIMIT 1
        `;
    } else if (/^[1-9]\d*$/.test(value)) {
        sql = `
            SELECT
                election_id,
                title,
                school_level,
                start_time,
                end_time,
                status,
                is_active,
                mask_names,
                scanning_open,
                voting_closed_at,
                scanning_closed_at
            FROM elections
            WHERE election_id = ?
            LIMIT 1
        `;

        params = [value];
    } else {
        const error = new Error("Invalid election ID");
        error.status = 400;
        throw error;
    }

    const [rows] = await connection.execute(sql, params);

    if (!rows.length) {
        const error = new Error(
            value.toLowerCase() === "current"
                ? "No current election found"
                : "Election not found"
        );

        error.status = 404;
        throw error;
    }

    return rows[0];
}

function sendError(res, error, label) {
    console.error(label, error);

    return res.status(error.status || 500).json({
        message: error.status
            ? error.message
            : "Internal server error"
    });
}

// Check kung officially released na ang results
function shouldRevealNames(election) {
    return (
        String(election.status || "").toLowerCase() === "completed" &&
        Boolean(election.scanning_closed_at) &&
        Number(election.scanning_open) === 0 &&
        Number(election.mask_names) === 0
    );
}

// Candidate preview bago magsimula ang voting
function isBeforeElection(election) {
    const status = String(
        election.status || ""
    ).toLowerCase();

    return (
        status !== "active" &&
        status !== "completed" &&
        !election.voting_closed_at &&
        !election.scanning_closed_at
    );
}

// Public names: preview o final results lang
function canShowNames(election) {
    return (
        isBeforeElection(election) ||
        shouldRevealNames(election)
    );
}

// Public votes: final results lang
function canShowVotes(election) {
    return shouldRevealNames(election);
}

// Ibigay ang tamang public election status
function formatPublicElection(election) {
    const revealNames = canShowNames(election);
    const finalized = shouldRevealNames(election);

    return {
        ...election,
        mask_names: revealNames ? 0 : 1,
        results_finalized: finalized,
        reveal_names: revealNames,
        reveal_votes: true
    };
}

// Election status
exports.getElectionStatus = async (req, res) => {
    try {
        const election = await resolveElection(
            req.params.election_id
        );

        return res.status(200).json({
            election: formatPublicElection(election)
        });

    } catch (error) {
        return sendError(
            res,
            error,
            "Get dashboard election status error:"
        );
    }
};

// Election candidates
exports.getCandidates = async (req, res) => {
    try {
        const election = await resolveElection(
            req.params.election_id
        );

        const [rows] = await connection.execute(
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
             INNER JOIN positions p
                ON p.position_id = c.position_id
             WHERE p.election_id = ?
             ORDER BY p.display_order,
                      c.display_order,
                      c.candidate_id`,
            [election.election_id]
        );

        const reveal = canShowNames(election);

        const candidates = rows.map(candidate => ({
            ...candidate,
            name: reveal
                ? candidate.name
                : `Candidate #${candidate.candidate_id}`
        }));

        return res.status(200).json({
            mask_names: !reveal,
            results_finalized: shouldRevealNames(election),
            candidates
        });

    } catch (error) {
        return sendError(
            res,
            error,
            "Get dashboard candidates error:"
        );
    }
};

// Vote tallies
exports.getTallies = async (req, res) => {
    try {
        const election = await resolveElection(
            req.params.election_id
        );

        const [rows] = await connection.execute(
            `SELECT *
             FROM v_live_tallies
             WHERE election_id = ?
             ORDER BY position_id, total_votes DESC`,
            [election.election_id]
        );

        const revealNames = canShowNames(election);
        const revealVotes = canShowVotes(election);

        const tallies = rows.map(tally => ({
            ...tally,
            candidate_name: revealNames
                ? tally.candidate_name
                : `Candidate #${tally.candidate_id}`,
            total_votes: revealVotes
                ? Number(tally.total_votes || 0)
                : 0
        }));

        return res.status(200).json({
            mask_names: !revealNames,
            results_finalized: revealVotes,
            tallies
        });

    } catch (error) {
        return sendError(
            res,
            error,
            "Get dashboard tallies error:"
        );
    }
};

// Shared overview query para consistent ang counting
async function buildOverview(election, adminAccess = false) {
    const electionId = election.election_id;

    const [positions] = await connection.execute(
        `SELECT
            position_id,
            title AS position_title,
            max_selection,
            display_order
         FROM positions
         WHERE election_id = ?
         ORDER BY display_order, position_id`,
        [electionId]
    );

    const [candidates] = await connection.execute(
        `SELECT
            c.candidate_id,
            c.position_id,
            c.name,
            c.course,
            c.grade_level,
            c.party_list,
            c.display_order,
            COUNT(bv.vote_id) AS total_votes
         FROM candidates c
         INNER JOIN positions p
            ON p.position_id = c.position_id
         LEFT JOIN ballot_votes bv
            ON bv.candidate_id = c.candidate_id
            AND bv.position_id = c.position_id
            AND EXISTS (
                SELECT 1
                FROM issued_ballots ib
                WHERE ib.ballot_id = bv.ballot_id
                  AND ib.election_id = ?
                  AND ib.status = 'COUNTED'
            )
         WHERE p.election_id = ?
         GROUP BY
            c.candidate_id,
            c.position_id,
            c.name,
            c.course,
            c.grade_level,
            c.party_list,
            c.display_order
         ORDER BY c.display_order, c.candidate_id`,
        [electionId, electionId]
    );

    const revealNames =
        adminAccess || canShowNames(election);

    const revealVotes = true;

    const result = positions.map(position => ({
        position_id: position.position_id,
        position_title: position.position_title,
        max_selection: position.max_selection,
        display_order: position.display_order,

        candidates: candidates
            .filter(candidate =>
                Number(candidate.position_id) ===
                Number(position.position_id)
            )
            .sort((a, b) =>
                revealVotes
                    ? Number(b.total_votes) -
                    Number(a.total_votes) ||
                    Number(a.display_order) -
                    Number(b.display_order) ||
                    Number(a.candidate_id) -
                    Number(b.candidate_id)
                    : Number(a.display_order) -
                    Number(b.display_order) ||
                    Number(a.candidate_id) -
                    Number(b.candidate_id)
            )
            .map(candidate => ({
                candidate_id: candidate.candidate_id,
                name: revealNames
                    ? candidate.name
                    : `Candidate #${candidate.candidate_id}`,
                course: revealNames ? candidate.course : null,
                grade_level: revealNames ? candidate.grade_level : null,
                party_list: revealNames ? candidate.party_list : null,
                display_order: candidate.display_order,
                total_votes: revealVotes
                    ? Number(candidate.total_votes || 0)
                    : 0
            }))
    }));

    const [ballotCount] = await connection.execute(
        `SELECT COUNT(*) AS total
         FROM issued_ballots
         WHERE election_id = ?
           AND status = 'COUNTED'`,
        [electionId]
    );

    const publicElection = formatPublicElection(election);

    return {
        election: adminAccess
            ? {
                ...election,
                results_finalized:
                    shouldRevealNames(election),
                reveal_names: true,
                reveal_votes: true
            }
            : publicElection,

        positions: result,


        statistics: {
            scanned_ballots: revealVotes
                ? Number(ballotCount[0]?.total || 0)
                : null,
            total_candidates: candidates.length
        }

    };
}

// Public dashboard overview
exports.getOverview = async (req, res) => {
    try {
        const election = await resolveElection(
            req.params.election_id
        );

        const overview = await buildOverview(
            election,
            false
        );

        return res.status(200).json(overview);

    } catch (error) {
        return sendError(
            res,
            error,
            "Dashboard overview error:"
        );
    }
};

// Protected Adviser, Committee at Super Admin overview
exports.getAdminOverview = async (req, res) => {
    try {
        const election = await resolveElection(
            req.params.election_id
        );

        const overview = await buildOverview(
            election,
            true
        );

        res.set("Cache-Control", "no-store");

        return res.status(200).json(overview);

    } catch (error) {
        return sendError(
            res,
            error,
            "Admin dashboard overview error:"
        );
    }
};

exports.getAnalytics = async (req, res) => {
    try {
        const election = await resolveElection(
            req.params.election_id
        );

        const electionId = Number(
            election.election_id
        );

        const scopeType =
            election.school_level === "college"
                ? "department"
                : "grade";

        const [scopes] = await connection.execute(
            `SELECT
                scope_id,
                scope_code,
                scope_name,
                scope_type
             FROM election_scopes
             WHERE election_id = ?
               AND scope_type = ?
             ORDER BY scope_id`,
            [electionId, scopeType]
        );

        // Public results must remain hidden

        const selectedScope = String(
            req.query.scope_id || "all"
        );

        if (
            selectedScope !== "all" &&
            selectedScope !== "legacy" &&
            !scopes.some(
                scope =>
                    String(scope.scope_id) === selectedScope
            )
        ) {
            return res.status(400).json({
                message: "Invalid department or grade."
            });
        }

        let scopeCondition = "";
        const params = [electionId];

        if (selectedScope === "legacy") {
            scopeCondition =
                "AND ib.scope_id IS NULL";
        } else if (selectedScope !== "all") {
            scopeCondition =
                "AND ib.scope_id = ?";

            params.push(Number(selectedScope));
        }

        // Registered and counted ballot statistics
        const [[summary]] =
            await connection.execute(
                `SELECT
                    COUNT(*) AS registered_ballots,

                    COALESCE(SUM(
                        CASE
                            WHEN ib.status = 'COUNTED'
                            THEN 1 ELSE 0
                        END
                    ), 0) AS counted_ballots,

                    COALESCE(SUM(
                        CASE
                            WHEN ib.scope_id IS NULL
                            THEN 1 ELSE 0
                        END
                    ), 0) AS legacy_ballots

                 FROM issued_ballots ib
                 WHERE ib.election_id = ?
                 ${scopeCondition}`,
                params
            );

        const registered = Number(
            summary.registered_ballots || 0
        );

        const counted = Number(
            summary.counted_ballots || 0
        );

        const countingPercentage =
            registered > 0
                ? Number(
                    ((counted / registered) * 100)
                        .toFixed(2)
                )
                : null;

        // Cumulative counting time series
        const [timeRows] =
            await connection.execute(
                `SELECT
                    FLOOR(
                        UNIX_TIMESTAMP(ib.counted_at) / 3600
                    ) * 3600 AS hour_start,

                    COUNT(*) AS ballots

                 FROM issued_ballots ib
                 WHERE ib.election_id = ?
                   AND ib.status = 'COUNTED'
                   AND ib.counted_at IS NOT NULL
                   ${scopeCondition}

                 GROUP BY hour_start
                 ORDER BY hour_start`,
                params
            );

        let cumulative = 0;

        const timeline = timeRows.map(row => {
            cumulative += Number(row.ballots);

            return {
                timestamp:
                    Number(row.hour_start) * 1000,

                counted_ballots: cumulative
            };
        });

        // Count valid recorded selections per ballot
        // and per applicable position.
        const [positionRows] =
            await connection.execute(
                `SELECT
                    p.position_id,

                    COUNT(*) AS applicable_ballots,

                    SUM(
                        CASE
                            WHEN COALESCE(v.selections, 0) = 0
                            THEN 1 ELSE 0
                        END
                    ) AS no_recorded_vote,

                    SUM(
                        CASE
                            WHEN v.selections > 0
                             AND v.selections <
                                 COALESCE(p.max_selection, 1)
                            THEN 1 ELSE 0
                        END
                    ) AS partial_selections

                 FROM positions p

                 INNER JOIN issued_ballots ib
                    ON ib.election_id = p.election_id
                   AND ib.status = 'COUNTED'

                 LEFT JOIN (
                    SELECT
                        bv.ballot_id,
                        bv.position_id,
                        COUNT(DISTINCT bv.candidate_id)
                            AS selections
                    FROM ballot_votes bv
                    GROUP BY
                        bv.ballot_id,
                        bv.position_id
                 ) v
                    ON v.ballot_id = ib.ballot_id
                   AND v.position_id = p.position_id

                 WHERE ib.election_id = ?

                 ${scopeCondition}

                 AND EXISTS (
                    SELECT 1
                    FROM omr_grid_coordinates g
                    INNER JOIN candidates c
                        ON c.candidate_id = g.candidate_id
                    WHERE g.template_id = ib.template_id
                      AND c.position_id = p.position_id
                 )

                 GROUP BY p.position_id`,
                params
            );

        // Candidate tallies for selected scope
        const [candidateRows] =
            await connection.execute(
                `SELECT
                    bv.candidate_id,
                    COUNT(DISTINCT ib.ballot_id)
                        AS total_votes

                 FROM ballot_votes bv
                 INNER JOIN issued_ballots ib
                    ON ib.ballot_id = bv.ballot_id

                 INNER JOIN candidates c
                    ON c.candidate_id = bv.candidate_id
                   AND c.position_id = bv.position_id
                   AND c.election_id = ib.election_id

                 WHERE ib.election_id = ?
                   AND ib.status = 'COUNTED'

                 ${scopeCondition}

                 GROUP BY bv.candidate_id`,
                params
            );

        res.set("Cache-Control", "no-store");

        return res.json({
            school_level: election.school_level,
            scopes,
            selected_scope: selectedScope,
            results_hidden: false,

            statistics: {
                registered_ballots: registered,
                counted_ballots: counted,

                legacy_ballots: Number(
                    summary.legacy_ballots || 0
                ),

                counting_percentage:
                    countingPercentage
            },

            timeline,

            positions: positionRows.map(row => ({
                position_id: Number(row.position_id),

                applicable_ballots: Number(
                    row.applicable_ballots || 0
                ),

                no_recorded_vote: Number(
                    row.no_recorded_vote || 0
                ),

                partial_selections: Number(
                    row.partial_selections || 0
                )
            })),

            candidate_tallies: candidateRows.map(row => ({
                candidate_id: Number(row.candidate_id),

                total_votes: Number(row.total_votes)
            }))
        });

    } catch (error) {
        return sendError(
            res,
            error,
            "Dashboard analytics error:"
        );
    }
};
