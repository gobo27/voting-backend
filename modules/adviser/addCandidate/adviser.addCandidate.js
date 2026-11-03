
const connection = require("../../../config/db");

// Valid school levels, grades, at party lists
const SCHOOL_LEVEL_CONFIG = {
    elementary: {
        grades: ["3", "4", "5", "6"],
        parties: ["LIVES", "MOVES"]
    },
    highschool: {
        grades: ["7", "8", "9", "10", "11", "12"],
        parties: ["CHAMPS", "ACTS"]
    },
    college: {
        grades: ["1", "2", "3", "4"],
        parties: ["Maroon", "White", "Independent"]
    }
};

function validId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0;
}

function normalizeSchoolLevel(value) {
    const level = String(value || "")
        .trim()
        .toLowerCase();

    return SCHOOL_LEVEL_CONFIG[level]
        ? level
        : null;
}

// I-validate ang candidate ayon sa current school level
function validateCandidate(body, schoolLevel) {
    const config = SCHOOL_LEVEL_CONFIG[schoolLevel];

    if (!config) {
        return {
            valid: false,
            message: "Invalid school level for the current election"
        };
    }

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
        name.trim().length > 100
    ) {
        return {
            valid: false,
            message: "Candidate name must be 1 to 100 characters"
        };
    }

    if (
        typeof course !== "string" ||
        !course.trim() ||
        course.trim().length > 255
    ) {
        return {
            valid: false,
            message: "Course must be 1 to 255 characters"
        };
    }

    const grade = String(grade_level ?? "").trim();

    if (!config.grades.includes(grade)) {
        return {
            valid: false,
            message:
                `Invalid grade/year for ${schoolLevel}. ` +
                `Allowed values: ${config.grades.join(", ")}`
        };
    }

    if (
        typeof party_list !== "string" ||
        !party_list.trim() ||
        party_list.trim().length > 100
    ) {
        return {
            valid: false,
            message: "Invalid party list"
        };
    }

    const selectedParty = party_list.trim();

    const validParty = config.parties.find(
        party =>
            party.toLowerCase() ===
            selectedParty.toLowerCase()
    );

    if (!validParty) {
        return {
            valid: false,
            message:
                `Invalid party list for ${schoolLevel}. ` +
                `Allowed: ${config.parties.join(", ")}`
        };
    }

    if (!validId(position_id)) {
        return {
            valid: false,
            message: "Invalid position ID"
        };
    }

    return {
        valid: true,
        data: {
            name: name.trim(),
            course: course.trim(),
            grade_level: grade,
            party_list: validParty,
            position_id: Number(position_id)
        }
    };
}

// Kunin ang current election kasama ang school level
async function getCurrentElection() {
    const [rows] = await connection.execute(
        `SELECT
            election_id,
            title,
            school_level,
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

// Bawal mag-edit kapag active o completed na
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

// GET /candidates
exports.getCandidates = async (req, res) => {
    try {
        const election = await getCurrentElection();

        if (!election) {
            return res.status(200).json({
                election_id: "",
                school_level: null,
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
            school_level: election.school_level,
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

// POST /candidates
exports.addCandidate = async (req, res) => {
    try {
        const election = await getCurrentElection();

        if (!election) {
            return res.status(409).json({
                message: "No current election available"
            });
        }

        if (!canManageCandidates(election)) {
            return res.status(409).json({
                message:
                    "Candidate management is locked while voting is in progress or the election has ended."
            });
        }

        const schoolLevel = normalizeSchoolLevel(
            election.school_level
        );

        const validation = validateCandidate(
            req.body,
            schoolLevel
        );

        if (!validation.valid) {
            return res.status(400).json({
                message: validation.message
            });
        }

        const data = validation.data;

        // Siguraduhing current election ang position
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
                school_level: schoolLevel,
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

// PUT /candidates/:id
exports.updateCandidate = async (req, res) => {
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

        const schoolLevel = normalizeSchoolLevel(
            election.school_level
        );

        const validation = validateCandidate(
            req.body,
            schoolLevel
        );

        if (!validation.valid) {
            return res.status(400).json({
                message: validation.message
            });
        }

        const data = validation.data;

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
            Number(candidates[0].election_id) !==
            Number(election.election_id)
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
                school_level: schoolLevel,
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

// DELETE /candidates/:id
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
            Number(candidates[0].election_id) !==
            Number(election.election_id)
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
