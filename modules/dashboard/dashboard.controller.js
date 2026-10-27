
"use strict";

const connection = require("../../config/db");

// Resolve current election or a specific historical election.
async function resolveElection(electionId) {
    const value = String(electionId ?? "").trim();

    let sql;
    let params = [];

    if (value.toLowerCase() === "current") {
        sql = `
            SELECT election_id, title, start_time, end_time,
                   status, is_active, mask_names
            FROM elections
            WHERE is_current = 1
              AND archived_at IS NULL
            LIMIT 1
        `;
    } else if (/^[1-9]\d*$/.test(value)) {
        sql = `
            SELECT election_id, title, start_time, end_time,
                   status, is_active, mask_names
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

function shouldRevealNames(election) {
    return (
        String(election.status).toLowerCase() === "completed" &&
        !Boolean(Number(election.mask_names))
    );
}

// Election status
exports.getElectionStatus = async (req, res) => {
    try {
        const election = await resolveElection(
            req.params.election_id
        );

        return res.status(200).json({ election });
    } catch (error) {
        return sendError(
            res, error, "Get dashboard election status error:"
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

        const reveal = shouldRevealNames(election);

        const candidates = rows.map(candidate => ({
            ...candidate,
            name: reveal
                ? candidate.name
                : `Candidate #${candidate.candidate_id}`
        }));

        return res.status(200).json({
            mask_names: !reveal,
            candidates
        });
    } catch (error) {
        return sendError(
            res, error, "Get dashboard candidates error:"
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

        const reveal = shouldRevealNames(election);

        const tallies = rows.map(tally => ({
            ...tally,
            candidate_name: reveal
                ? tally.candidate_name
                : `Candidate #${tally.candidate_id}`
        }));

        return res.status(200).json({
            mask_names: !reveal,
            tallies
        });
    } catch (error) {
        return sendError(
            res, error, "Get dashboard tallies error:"
        );
    }
};

// Full dashboard overview
exports.getOverview = async (req, res) => {
    try {
        const election = await resolveElection(
            req.params.election_id
        );

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
                    FROM scanned_ballots sb
                    WHERE sb.ballot_id = bv.ballot_id
                      AND sb.election_id = ?
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

        const revealNames = shouldRevealNames(election);

        const result = positions.map(position => ({
            position_id: position.position_id,
            position_title: position.position_title,
            max_selection: position.max_selection,
            candidates: candidates
                .filter(candidate =>
                    Number(candidate.position_id) ===
                    Number(position.position_id)
                )
                .map(candidate => ({
                    candidate_id: candidate.candidate_id,
                    name: revealNames
                        ? candidate.name
                        : `Candidate #${candidate.candidate_id}`,
                    course: candidate.course,
                    grade_level: candidate.grade_level,
                    party_list: candidate.party_list,
                    total_votes: Number(candidate.total_votes)
                }))
        }));

        const [ballotCount] = await connection.execute(
            `SELECT COUNT(*) AS total
             FROM scanned_ballots
             WHERE election_id = ?`,
            [electionId]
        );

        return res.status(200).json({
            election,
            positions: result,
            statistics: {
                scanned_ballots: Number(ballotCount[0].total),
                total_candidates: candidates.length
            }
        });

    } catch (error) {
        return sendError(
            res, error, "Dashboard overview error:"
        );
    }
};
