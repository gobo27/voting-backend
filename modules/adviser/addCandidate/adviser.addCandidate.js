
const connection = require("../../../config/db");

// ================= HELPERS =================

function validId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0;
}

function validateCandidate(body) {
    const {
        name,
        course,
        grade_level,
        party_list,
        position_id
    } = body || {};

    if (
        typeof name !== "string" ||
        !name.trim() ||
        name.trim().length > 100 ||
        typeof course !== "string" ||
        !course.trim() ||
        course.trim().length > 255 ||
        !["1", "2", "3", "4"].includes(String(grade_level)) ||
        typeof party_list !== "string" ||
        !party_list.trim() ||
        party_list.trim().length > 100 ||
        !validId(position_id)
    ) {
        return null;
    }

    return {
        name: name.trim(),
        course: course.trim(),
        grade_level: String(grade_level),
        party_list: party_list.trim(),
        position_id: Number(position_id)
    };
}

// Get current election from database
async function getCurrentElection() {
    const [rows] = await connection.execute(
        `SELECT
            election_id,
            title,
            status,
            is_active,
            is_current,
            archived_at
         FROM elections
         WHERE is_current = 1
           AND archived_at IS NULL
         LIMIT 1`
    );

    return rows.length ? rows[0] : null;
}

// Candidate changes are not allowed once voting is completed.
function canManageCandidates(election) {
    if (!election) return false;

    const status = String(election.status || "")
        .trim()
        .toLowerCase();

    return (
        election.archived_at === null &&
        Number(election.is_current) === 1 &&
        Number(election.is_active) === 0 &&
        status !== "active" &&
        status !== "completed"
    );
}


function serverError(res, label, error) {
    console.error(label, error);

    return res.status(500).json({
        message: "Internal server error"
    });
}

// ================= GET CANDIDATES =================

exports.getCandidates = async (req, res) => {
    try {
        const election = await getCurrentElection();

        if (!election) {
            return res.status(200).json({
                election_id: null,
                candidates: [],
                message: "No current election found"
            });
        }

        const [rows] = await connection.execute(
            `SELECT
                c.*,
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

        return res.status(200).json({
            election_id: election.election_id,
            candidates: rows
        });

    } catch (error) {
        return serverError(
            res,
            "Get candidates error:",
            error
        );
    }
};

// ================= ADD CANDIDATE =================

exports.addCandidate = async (req, res) => {
    try {
        const data = validateCandidate(req.body);

        if (!data) {
            return res.status(400).json({
                message: "Invalid candidate information"
            });
        }

        const election = await getCurrentElection();

        if (!election) {
            return res.status(409).json({
                message: "No current election available"
            });
        }

        if (!canManageCandidates(election)) {
            return res.status(409).json({
                message: "Candidate management is locked while voting is in progress or the election has ended."
            });
        }

        // Position must belong to current election.
        const [positions] = await connection.execute(
            `SELECT p.position_id
             FROM positions p
             JOIN elections e
               ON e.election_id = p.election_id
             WHERE p.position_id = ?
               AND e.election_id = ?
               AND e.is_current = 1
               AND e.archived_at IS NULL
               AND (e.status IS NULL OR e.status <> 'completed')
             LIMIT 1`,
            [
                data.position_id,
                election.election_id
            ]
        );

        if (!positions.length) {
            return res.status(400).json({
                message:
                    "Position does not belong to the current election"
            });
        }

        const [result] = await connection.execute(
            `INSERT INTO candidates
             (
                election_id,
                name,
                course,
                grade_level,
                party_list,
                position_id,
                display_order
             )
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                election.election_id,
                data.name,
                data.course,
                data.grade_level,
                data.party_list,
                data.position_id,
                1
            ]
        );

        return res.status(201).json({
            message: "Candidate added successfully",
            candidate: {
                candidate_id: result.insertId,
                election_id: election.election_id,
                ...data
            }
        });

    } catch (error) {
        return serverError(
            res,
            "Add candidate error:",
            error
        );
    }
};

// ================= UPDATE CANDIDATE =================

exports.updateCandidate = async (req, res) => {
    try {
        const id = Number(req.params.id);
        const data = validateCandidate(req.body);

        if (!validId(id)) {
            return res.status(400).json({
                message: "Invalid candidate ID"
            });
        }

        if (!data) {
            return res.status(400).json({
                message: "Invalid candidate information"
            });
        }

        const election = await getCurrentElection();

        if (!election || !canManageCandidates(election)) {
            return res.status(409).json({
                message:
                    "No editable current election available"
            });
        }

        const [candidates] = await connection.execute(
            `SELECT candidate_id, election_id
             FROM candidates
             WHERE candidate_id = ?
             LIMIT 1`,
            [id]
        );

        if (!candidates.length) {
            return res.status(404).json({
                message: "Candidate not found"
            });
        }

        if (
            candidates[0].election_id !==
            election.election_id
        ) {
            return res.status(403).json({
                message:
                    "Cannot edit a candidate from another election"
            });
        }

        const [positions] = await connection.execute(
            `SELECT position_id
             FROM positions
             WHERE position_id = ?
               AND election_id = ?
             LIMIT 1`,
            [
                data.position_id,
                election.election_id
            ]
        );

        if (!positions.length) {
            return res.status(400).json({
                message:
                    "Position does not belong to the current election"
            });
        }

        const [result] = await connection.execute(
            `UPDATE candidates c
             JOIN elections e
               ON e.election_id = c.election_id
             SET
                c.name = ?,
                c.course = ?,
                c.grade_level = ?,
                c.party_list = ?,
                c.position_id = ?
             WHERE c.candidate_id = ?
               AND e.election_id = ?
               AND e.is_current = 1
               AND e.archived_at IS NULL
               AND (e.status IS NULL OR e.status <> 'completed')`,
            [
                data.name,
                data.course,
                data.grade_level,
                data.party_list,
                data.position_id,
                id,
                election.election_id
            ]
        );

        if (!result.affectedRows) {
            return res.status(409).json({
                message:
                    "Candidate could not be updated; election may have changed"
            });
        }

        return res.status(200).json({
            message: "Candidate updated successfully",
            candidate: {
                candidate_id: id,
                election_id: election.election_id,
                ...data
            }
        });

    } catch (error) {
        return serverError(
            res,
            "Update candidate error:",
            error
        );
    }
};

// ================= DELETE CANDIDATE =================

exports.deleteCandidate = async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!validId(id)) {
            return res.status(400).json({
                message: "Invalid candidate ID"
            });
        }

        const election = await getCurrentElection();

        if (!election || !canManageCandidates(election)) {
            return res.status(409).json({
                message:
                    "No editable current election available"
            });
        }

        const [candidates] = await connection.execute(
            `SELECT candidate_id, election_id
             FROM candidates
             WHERE candidate_id = ?
             LIMIT 1`,
            [id]
        );

        if (!candidates.length) {
            return res.status(404).json({
                message: "Candidate not found"
            });
        }

        if (
            candidates[0].election_id !==
            election.election_id
        ) {
            return res.status(403).json({
                message:
                    "Cannot delete a candidate from another election"
            });
        }

        const [result] = await connection.execute(
            `DELETE c
             FROM candidates c
             JOIN elections e
               ON e.election_id = c.election_id
             WHERE c.candidate_id = ?
               AND e.election_id = ?
               AND e.is_current = 1
               AND e.archived_at IS NULL
               AND (e.status IS NULL OR e.status <> 'completed')`,
            [
                id,
                election.election_id
            ]
        );

        if (!result.affectedRows) {
            return res.status(409).json({
                message:
                    "Candidate could not be deleted; election may have changed"
            });
        }

        return res.status(200).json({
            message: "Candidate deleted successfully"
        });

    } catch (error) {
        return serverError(
            res,
            "Delete candidate error:",
            error
        );
    }
};
