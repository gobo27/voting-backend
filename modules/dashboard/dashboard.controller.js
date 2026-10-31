
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
        reveal_votes: finalized
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

    const revealVotes =true;

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
                course: candidate.course,
                grade_level: candidate.grade_level,
                party_list: candidate.party_list,
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
            scanned_ballots: Number(ballotCount[0]?.total || 0),
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
