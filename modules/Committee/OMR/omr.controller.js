
"use strict";

const sharp = require("sharp");
const jsQR = require("jsqr");
const fs = require("fs/promises");
const pool = require("../../../config/db");

const DPI = 300;

const PAPER_DIMENSIONS = Object.freeze({
    A5: {
        width: Math.round(148.5 * DPI / 25.4),
        height: Math.round(210 * DPI / 25.4)
    },
    A4: {
        width: Math.round(210 * DPI / 25.4),
        height: Math.round(297 * DPI / 25.4)
    }
});

const COUNTING_SENSITIVITY = 2;
const mm = value => value * DPI / 25.4;

function validId(value) {
    const number = Number(value);

    return Number.isSafeInteger(number) && number > 0;
}

function median(values) {
    if (!values.length) return 255;

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function parseQR(qrData) {
    const parts = String(qrData || "")
        .trim()
        .split("|");

    const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
        parts.length !== 4 ||
        parts[0] !== "CV1" ||
        !validId(parts[1]) ||
        !uuidPattern.test(parts[2]) ||
        !validId(parts[3])
    ) {
        throw new Error(
            "Invalid CampusVote ballot QR code."
        );
    }

    return {
        election_id: Number(parts[1]),
        ballot_id: parts[2].toLowerCase(),
        template_id: Number(parts[3])
    };
}

async function readBallotQR(imagePath) {
    const { data, info } = await sharp(imagePath)
        .rotate()
        .ensureAlpha()
        .raw()
        .toBuffer({
            resolveWithObject: true
        });

    let result = jsQR(
        new Uint8ClampedArray(data),
        info.width,
        info.height,
        {
            inversionAttempts: "attemptBoth"
        }
    );

    if (!result) {
        const cropX = Math.floor(
            info.width * 0.65
        );

        const cropWidth =
            info.width - cropX;

        const cropHeight = Math.max(
            1,
            Math.floor(info.height * 0.40)
        );

        const crop = await sharp(imagePath)
            .rotate()
            .extract({
                left: cropX,
                top: 0,
                width: cropWidth,
                height: cropHeight
            })
            .ensureAlpha()
            .raw()
            .toBuffer({
                resolveWithObject: true
            });

        result = jsQR(
            new Uint8ClampedArray(crop.data),
            crop.info.width,
            crop.info.height,
            {
                inversionAttempts: "attemptBoth"
            }
        );
    }

    if (!result) {
        throw new Error(
            "QR code not detected. No votes recorded."
        );
    }

    return parseQR(result.data);
}

async function getTemplateCoordinates(
    db,
    templateId,
    electionId
) {
    const [templates] = await db.execute(
        `SELECT
            template_id,
            election_id,
            paper_size
         FROM ballot_templates
         WHERE template_id = ?
           AND election_id = ?
         LIMIT 1`,
        [
            templateId,
            electionId
        ]
    );

    if (!templates.length) {
        return null;
    }

    const [coordinates] = await db.execute(
        `SELECT
            g.coord_id,
            g.candidate_id,
            g.bubble_code,
            g.x_pos,
            g.y_pos,
            g.width,
            g.height,
            c.name AS candidate_name,
            c.position_id,
            p.title AS position_name,
            p.max_selection
         FROM omr_grid_coordinates g
         JOIN candidates c
           ON c.candidate_id = g.candidate_id
         JOIN positions p
           ON p.position_id = c.position_id
         WHERE g.template_id = ?
           AND c.election_id = ?
           AND p.election_id = ?
         ORDER BY
            p.position_id,
            g.y_pos,
            g.x_pos`,
        [
            templateId,
            electionId,
            electionId
        ]
    );

    return {
        template: templates[0],
        coordinates
    };
}

// REGISTRATION MARKERS

async function findMarkers(
    imagePath,
    originalWidth,
    originalHeight
) {
    const scale = Math.min(
        1,
        1100 / Math.max(
            originalWidth,
            originalHeight
        )
    );

    const w = Math.max(
        1,
        Math.round(originalWidth * scale)
    );

    const h = Math.max(
        1,
        Math.round(originalHeight * scale)
    );

    const { data } = await sharp(imagePath)
        .rotate()
        .resize(w, h, {
            fit: "fill"
        })
        .grayscale()
        .raw()
        .toBuffer({
            resolveWithObject: true
        });

    const mask = new Uint8Array(w * h);
    const seen = new Uint8Array(w * h);

    for (let i = 0; i < mask.length; i++) {
        mask[i] = data[i] < 95 ? 1 : 0;
    }

    const corners = [
        [0, 0],
        [w - 1, 0],
        [0, h - 1],
        [w - 1, h - 1]
    ];

    const found = [];

    for (const [cx, cy] of corners) {
        const x0 = cx === 0
            ? 0
            : Math.floor(w * 0.66);

        const x1 = cx === 0
            ? Math.ceil(w * 0.34)
            : w;

        const y0 = cy === 0
            ? 0
            : Math.floor(h * 0.66);

        const y1 = cy === 0
            ? Math.ceil(h * 0.34)
            : h;

        let best = null;

        for (let yy = y0; yy < y1; yy++) {
            for (let xx = x0; xx < x1; xx++) {
                const start = yy * w + xx;

                if (
                    !mask[start] ||
                    seen[start]
                ) {
                    continue;
                }

                const stack = [start];
                seen[start] = 1;

                let area = 0;

                let minX = xx;
                let maxX = xx;
                let minY = yy;
                let maxY = yy;

                let sx = 0;
                let sy = 0;

                while (stack.length) {
                    const n = stack.pop();

                    const px = n % w;
                    const py = Math.floor(n / w);

                    area++;
                    sx += px;
                    sy += py;

                    minX = Math.min(minX, px);
                    maxX = Math.max(maxX, px);
                    minY = Math.min(minY, py);
                    maxY = Math.max(maxY, py);

                    if (px > x0) {
                        const q = n - 1;

                        if (
                            mask[q] &&
                            !seen[q]
                        ) {
                            seen[q] = 1;
                            stack.push(q);
                        }
                    }

                    if (px + 1 < x1) {
                        const q = n + 1;

                        if (
                            mask[q] &&
                            !seen[q]
                        ) {
                            seen[q] = 1;
                            stack.push(q);
                        }
                    }

                    if (py > y0) {
                        const q = n - w;

                        if (
                            mask[q] &&
                            !seen[q]
                        ) {
                            seen[q] = 1;
                            stack.push(q);
                        }
                    }

                    if (py + 1 < y1) {
                        const q = n + w;

                        if (
                            mask[q] &&
                            !seen[q]
                        ) {
                            seen[q] = 1;
                            stack.push(q);
                        }
                    }

                    }
                }

                const bw = maxX - minX + 1;
                const bh = maxY - minY + 1;

                const ratio = bw / bh;
                const density = area / (bw * bh);

                if (
                    area < 8 ||
                    bw < 3 ||
                    bh < 3 ||
                    bw > w * 0.08 ||
                    bh > h * 0.08 ||
                    ratio < 0.6 ||
                    ratio > 1.65 ||
                    density < 0.72
                ) {
                    continue;
                }

                const mx = sx / area;
                const my = sy / area;

                const distance = Math.hypot(
                    mx - cx,
                    my - cy
                );

                const score = area / (
                    1 + distance
                );

                if (
                    !best ||
                    score > best.score
                ) {
                    best = {
                        x: mx / scale,
                        y: my / scale,
                        score
                    };
                }
            }
        }

        if (!best) {
            throw new Error(
                "Four registration squares not detected. " +
                "Keep all four corners visible."
            );
        }

        found.push(best);
    }

    const [tl, tr, bl, br] = found;

    const topWidth = Math.hypot(
        tr.x - tl.x,
        tr.y - tl.y
    );

    const bottomWidth = Math.hypot(
        br.x - bl.x,
        br.y - bl.y
    );

    const leftHeight = Math.hypot(
        bl.x - tl.x,
        bl.y - tl.y
    );

    const rightHeight = Math.hypot(
        br.x - tr.x,
        br.y - tr.y
    );

    if (
        topWidth < originalWidth * 0.45 ||
        bottomWidth < originalWidth * 0.45 ||
        leftHeight < originalHeight * 0.45 ||
        rightHeight < originalHeight * 0.45
    ) {
        throw new Error(
            "Registration markers are too close together."
        );
    }

    return [tl, tr, bl, br];


/* HOMOGRAPHY AND COORDINATE ALIGNMENT */

function solve8(A, b) {
    for (let i = 0; i < 8; i++) {
        let pivot = i;

        for (let j = i + 1; j < 8; j++) {
            if (Math.abs(A[j][i]) > Math.abs(A[pivot][i])) {
                pivot = j;
            }
        }

        [A[i], A[pivot]] = [A[pivot], A[i]];
        [b[i], b[pivot]] = [b[pivot], b[i]];

        if (Math.abs(A[i][i]) < 1e-10) {
            throw new Error("Invalid marker geometry.");
        }

        const divisor = A[i][i];

        for (let k = i; k < 8; k++) {
            A[i][k] /= divisor;
        }

        b[i] /= divisor;

        for (let j = 0; j < 8; j++) {
            if (j === i) continue;

            const factor = A[j][i];

            for (let k = i; k < 8; k++) {
                A[j][k] -= factor * A[i][k];
            }

            b[j] -= factor * b[i];
        }
    }

    return b;
}

function homography(from, to) {
    const A = [];
    const b = [];

    for (let i = 0; i < 4; i++) {
        const { x, y } = from[i];
        const { x: u, y: v } = to[i];

        A.push([
            x, y, 1,
            0, 0, 0,
            -u * x,
            -u * y
        ]);

        b.push(u);

        A.push([
            0, 0, 0,
            x, y, 1,
            -v * x,
            -v * y
        ]);

        b.push(v);
    }

    return solve8(A, b);
}

function project(H, x, y) {
    const d = H[6] * x + H[7] * y + 1;

    if (Math.abs(d) < 1e-10) {
        return null;
    }

    return {
        x: (
            H[0] * x +
            H[1] * y +
            H[2]
        ) / d,

        y: (
            H[3] * x +
            H[4] * y +
            H[5]
        ) / d
    };
}

function sample(image, H, x, y) {
    const point = project(H, x, y);

    if (!point) {
        return null;
    }

    const px = Math.round(point.x);
    const py = Math.round(point.y);

    if (
        px < 0 ||
        py < 0 ||
        px >= image.width ||
        py >= image.height
    ) {
        return null;
    }

    return image.data[
        py * image.width + px
    ];
}

/* OMR BUBBLE DETECTION */

function measure(image, H, coordinate, sensitivity, dimensions) {
    const x = Number(coordinate.x_pos);
    const y = Number(coordinate.y_pos);
    const w = Number(coordinate.width);
    const h = Number(coordinate.height);

    if (
        ![x, y, w, h].every(Number.isFinite) ||
        w <= 0 ||
        h <= 0 ||
        x < 0 ||
        y < 0 ||
        x + w > dimensions.width ||
        y + h > dimensions.height
    ) {
        throw new Error("Invalid saved bubble coordinates.");
    }

    const cx = x + w / 2;
    const cy = y + h / 2;

    const inside = [];
    const paper = [];

    for (let j = -12; j <= 12; j++) {
        for (let i = -12; i <= 12; i++) {
            const r = Math.hypot(i / 12, j / 12);

            if (r > 0.60) continue;

            const value = sample(
                image,
                H,
                cx + (i / 12) * w * 0.42,
                cy + (j / 12) * h * 0.42
            );

            if (value !== null) {
                inside.push(value);
            }
        }
    }

    for (let j = -16; j <= 16; j++) {
        for (let i = -16; i <= 16; i++) {
            const r = Math.hypot(i / 16, j / 16);

            if (r < 0.75 || r > 1) continue;

            const value = sample(
                image,
                H,
                cx + (i / 16) * w * 0.95,
                cy + (j / 16) * h * 0.95
            );

            if (value !== null) {
                paper.push(value);
            }
        }
    }

    if (inside.length < 50 || paper.length < 12) {
        throw new Error(
            "Insufficient bubble samples. Check image alignment."
        );
    }

    const sortedPaper = [...paper].sort((a, b) => a - b);

    const brightPaper = sortedPaper.slice(
        Math.floor(sortedPaper.length * 0.5)
    );

    const baseline = median(brightPaper);

    const differences = inside.map(value =>
        Math.max(0, baseline - value)
    );

    const average = differences.reduce(
        (sum, value) => sum + value,
        0
    ) / differences.length;

    const settings = {
        1: {
            contrast: 32,
            minimum: 21,
            requiredMarked: 0.32
        },
        2: {
            contrast: 21,
            minimum: 13,
            requiredMarked: 0.24
        },
        3: {
            contrast: 13,
            minimum: 8,
            requiredMarked: 0.19
        }
    };

    const setting = settings[sensitivity] || settings[2];

    const marked = differences.filter(
        value => value > setting.contrast
    ).length / differences.length;

    return {
        selected:
            average >= setting.minimum &&
            marked >= setting.requiredMarked,
        average,
        marked,
        baseline
    };
}

/* POSITION VOTE VALIDATION */

function validatePositionVotes(grouped) {
    const positions = [...grouped.values()].map(position => {
        const markedCandidates = position.candidates.filter(candidate => candidate.filled);
        const marked = markedCandidates.length;
        const overvoted = marked > position.max_selection;
        const unclear = position.candidates.some(candidate => candidate.unclear);

        // Never silently discard confirmed votes because a bubble is ambiguous.
        // Ambiguous positions require a clearer scan before the ballot is finalized.
        let result = "BLANK";
        if (overvoted) {
            result = "SKIPPED_OVERVOTE";
        } else if (unclear) {
            result = "NEEDS_REVIEW";
        } else if (marked > 0) {

            result = "COUNTED";
        }

        return {
            ...position,
            marked,
            overvoted,
            unclear,
            result,
            recorded: result === "COUNTED" ? marked : 0
        };
    });

    const votes = positions.flatMap(position =>
        position.result === "COUNTED"
            ? position.candidates
                .filter(candidate => candidate.filled)
                .map(candidate => ({
                    candidate_id: candidate.candidate_id,
                    position_id: position.position_id,
                    fill_intensity: candidate.fill_intensity
                }))
            : []
    );

    return { positions, votes };
}

/* CANDIDATE BUBBLE ANALYSIS */

function analyzeBubbleCoordinates(image, H, coordinates, paper) {
    if (!Array.isArray(coordinates) || !coordinates.length) {
        throw new Error("No saved bubble coordinates found.");
    }

    const grouped = new Map();
    const seen = new Set();

    for (const coord of coordinates) {
        const candidateId = Number(coord.candidate_id);
        const positionId = Number(coord.position_id);
        const maxSelection = Number(coord.max_selection);

        if (
            !validId(candidateId) ||
            !validId(positionId) ||
            !validId(maxSelection) ||
            seen.has(candidateId)
        ) {
            throw new Error(
                "Invalid or duplicate saved coordinates."
            );
        }

        seen.add(candidateId);

        const measurement = measure(
            image,
            H,
            coord,
            COUNTING_SENSITIVITY,
            paper
        );

        if (!grouped.has(positionId)) {
            grouped.set(positionId, {
                position_id: positionId,
                position_name: coord.position_name,
                max_selection: maxSelection,
                candidates: []
            });
        }

        const position = grouped.get(positionId);

        if (position.max_selection !== maxSelection) {
            throw new Error(
                "Inconsistent maximum selections."
            );
        }

        const unclear =
            !measurement.selected &&
            measurement.average >= 9 &&
            measurement.average < 18 &&
            measurement.marked >= 0.12;

        position.candidates.push({
            candidate_id: candidateId,
            name: coord.candidate_name,
            filled: measurement.selected,
            unclear,
            fill_intensity:
                Math.round(measurement.marked * 10000) / 100,
            contrast:
                Math.round(measurement.average * 100) / 100
        });
    }

    return validatePositionVotes(grouped);
}

/* QR VERIFICATION */

exports.verifyQR = async (req, res) => {
    try {
        const qr = parseQR(req.body?.qr_data);

        const [rows] = await pool.execute(
            `SELECT ballot_id, election_id, template_id, status
             FROM issued_ballots
             WHERE ballot_id = ?
               AND election_id = ?
               AND template_id = ?
             LIMIT 1`,
            [qr.ballot_id, qr.election_id, qr.template_id]
        );

        if (!rows.length) {
            return res.status(422).json({
                valid: false,
                message: "Unregistered ballot."
            });
        }

        const ballot = rows[0];

        if (ballot.status === "COUNTED") {
            return res.status(409).json({
                valid: false,
                duplicate: true,
                status: "COUNTED",
                message: "Duplicate ballot. Already counted."
            });
        }

        if (ballot.status === "VOID") {
            return res.status(409).json({
                valid: false,
                status: "VOID",
                message: "This ballot has been voided."
            });
        }

        if (!["ISSUED", "CAST"].includes(ballot.status)) {
            return res.status(409).json({
                valid: false,
                status: ballot.status,
                message: "Ballot is not eligible for scanning."
            });
        }

        return res.status(200).json({
            valid: true,
            duplicate: false,
            status: ballot.status,
            ballot_id: ballot.ballot_id,
            election_id: ballot.election_id,
            template_id: ballot.template_id,
            message: "Valid ballot. Ready for OMR analysis."
        });

    } catch (error) {
        const invalid =
            error.message === "Invalid CampusVote ballot QR code.";

        if (!invalid) {
            console.error("QR verification error:", error);
        }

        return res.status(invalid ? 422 : 500).json({
            valid: false,
            message: invalid
                ? error.message
                : "QR verification failed."
        });
    }
};

/* BALLOT SCANNING AND VOTE COUNTING */

exports.uploadAndProcess = async (req, res) => {
    let db = null;
    let transactionStarted = false;

    const preview = req.omrPreview === true;
    const counting = req.omrCounting === true;

    const fail = (code, message, extra = {}) =>
        res.status(code).json({
            success: false,
            preview_only: !counting,
            counted: false,
            message,
            ...extra
        });

    const reject = (status, message, extra = {}) => {
        const error = new Error(message);
        error.httpStatus = status;
        Object.assign(error, extra);
        throw error;
    };

    try {
        if (preview === counting) {
            return fail(403, "Invalid OMR processing mode.");
        }

        if (counting && process.env.OMR_COUNTING_ENABLED !== "true") {
            return fail(403, "Live counting is disabled.");
        }

        const electionId = Number(req.body?.election_id);
        const templateId = Number(req.body?.template_id);

        if (!req.file?.path || !validId(electionId) || !validId(templateId)) {
            return fail(
                400,
                "Ballot image, election ID and template ID are required."
            );
        }

        let qr;

        try {
            qr = await readBallotQR(req.file.path);
        } catch (error) {
            return fail(422, error.message);
        }

        if (
            qr.election_id !== electionId ||
            qr.template_id !== templateId
        ) {
            return fail(
                422,
                "QR does not match the selected election or template."
            );
        }

        db = await pool.getConnection();

        const [ballots] = await db.execute(
            `SELECT status
             FROM issued_ballots
             WHERE ballot_id = ?
               AND election_id = ?
               AND template_id = ?
             LIMIT 1`,
            [qr.ballot_id, electionId, templateId]
        );

        if (!ballots.length) {
            return fail(422, "Unregistered ballot.");
        }

        const ballotStatus = ballots[0].status;

        if (!["ISSUED", "CAST"].includes(ballotStatus)) {
            return fail(409, "Ballot is not eligible for scanning.", {
                status: ballotStatus,
                duplicate: ballotStatus === "COUNTED"
            });
        }

        const record = await getTemplateCoordinates(
            db,
            templateId,
            electionId
        );

        if (!record) {
            return fail(404, "Ballot template not found.");
        }

        const paperSize = String(
            record.template.paper_size || ""
        ).toUpperCase();

        if (paperSize !== "A5") {
            return fail(422, "Only A5 portrait ballots are supported.");
        }

        if (
            !Array.isArray(record.coordinates) ||
            !record.coordinates.length
        ) {
            return fail(422, "No saved bubble coordinates found.");
        }

        const paper = PAPER_DIMENSIONS.A5;

        const oldX = Math.round(mm(18));
        const savedX = record.coordinates.map(
            coord => Number(coord.x_pos)
        );

        if (savedX.every(x => x === oldX)) {
            return fail(
                422,
                "This template uses the old A5 landscape layout."
            );
        }

        const { data, info } = await sharp(req.file.path)
            .rotate()
            .grayscale()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const image = {
            data,
            width: info.width,
            height: info.height
        };

        if (info.width < 500 || info.height < 700) {
            return fail(
                422,
                "Image resolution is too low. Use a clearer ballot scan."
            );
        }

        const aspect = info.width / info.height;
        const expectedAspect = paper.width / paper.height;

        if (Math.abs(aspect - expectedAspect) > 0.12) {
            return fail(
                422,
                "Expected one A5 portrait ballot per scan."
            );
        }

        let marks;
        let H;

        try {
            marks = await findMarkers(
                req.file.path,
                info.width,
                info.height
            );

            if (!Array.isArray(marks) || marks.length !== 4) {
                throw new Error("Four registration markers are required.");
            }

            const markerPoints = [
                { x: mm(9.5), y: mm(7.5) },

                { x: mm(138.5), y: mm(7.5) },
                { x: mm(9.5), y: mm(200.5) },
                { x: mm(138.5), y: mm(200.5) }
            ];

            H = homography(markerPoints, marks);

        } catch (error) {
            return fail(
                422,
                "Alignment failed. Retake the photo. " + error.message
            );
        }

        let analysis;

        try {
            analysis = analyzeBubbleCoordinates(
                image,
                H,
                record.coordinates,
                paper
            );
        } catch (error) {
            return fail(
                422,
                "Bubble alignment failed. " + error.message
            );
        }

        const { positions, votes } = analysis;

        // Never finalize a ballot with unresolved bubble readings.
        // This protects potentially valid votes from being lost.
        const needsReview = positions.filter(
            position => position.result === "NEEDS_REVIEW"
        );

        if (counting && needsReview.length) {
            return fail(
                422,
                "Unclear shading detected. No votes saved. Retake or rescan the ballot.",
                {
                    review_required: true,
                    positions,
                    unclear_positions: needsReview.map(
                        position => position.position_name
                    )
                }
            );
        }

        if (counting && votes.length === 0) {
            return fail(
                422,
                "Blank ballot detected. No votes counted. " +
                "This ballot can still be used."
            );
        }

        if (counting) {
            await db.beginTransaction();
            transactionStarted = true;

            const [elections] = await db.execute(
                `SELECT
                    status,
                    scanning_open,
                    scanning_closed_at,
                    is_current,
                    archived_at
                 FROM elections
                 WHERE election_id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [electionId]
            );

            const election = elections[0];

            const scanningAllowed =
                !!election &&
                Number(election.is_current) === 1 &&
                Number(election.scanning_open) === 1 &&
                !election.scanning_closed_at &&
                !election.archived_at &&
                ["active", "completed"].includes(
                    String(election.status).toLowerCase()
                );

            if (!scanningAllowed) {
                reject(
                    403,
                    "Election scanning is closed. No votes saved."
                );
            }

            const [locked] = await db.execute(
                `SELECT status
                 FROM issued_ballots
                 WHERE ballot_id = ?
                   AND election_id = ?
                   AND template_id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [
                    qr.ballot_id,
                    electionId,
                    templateId
                ]
            );

            if (!locked.length) {
                reject(422, "Unregistered ballot.");
            }

            if (!["ISSUED", "CAST"].includes(locked[0].status)) {
                reject(
                    409,
                    "Duplicate, void or unavailable ballot.",
                    {
                        duplicate:
                            locked[0].status === "COUNTED"
                    }
                );
            }

            // Verify every selected candidate belongs to this election.
            for (const vote of votes) {
                const [candidateRows] = await db.execute(
                    `SELECT c.candidate_id
                     FROM candidates c
                     INNER JOIN positions p
                       ON p.position_id = c.position_id
                     WHERE c.candidate_id = ?
                       AND c.position_id = ?
                       AND c.election_id = ?
                       AND p.election_id = ?
                     LIMIT 1`,
                    [
                        vote.candidate_id,
                        vote.position_id,
                        electionId,
                        electionId
                    ]
                );

                if (!candidateRows.length) {
                    reject(
                        422,
                        "Invalid candidate or position for this election."
                    );
                }
            }

            // Save all confirmed valid votes.
            for (const vote of votes) {
                await db.execute(
                    `INSERT INTO ballot_votes
                        (
                            ballot_id,
                            candidate_id,
                            position_id,
                            fill_intensity
                        )
                     VALUES (?, ?, ?, ?)`,
                    [
                        qr.ballot_id,
                        vote.candidate_id,
                        vote.position_id,
                        vote.fill_intensity
                    ]
                );
            }

            // Mark ballot as COUNTED only after votes are inserted.
            const [updated] = await db.execute(
                `UPDATE issued_ballots
                 SET
                    status = 'COUNTED',
                    counted_at = CURRENT_TIMESTAMP,
                    cast_at = COALESCE(
                        cast_at,
                        CURRENT_TIMESTAMP
                    )
                 WHERE ballot_id = ?
                   AND election_id = ?
                   AND template_id = ?
                   AND status IN ('ISSUED', 'CAST')`,
                [
                    qr.ballot_id,
                    electionId,
                    templateId
                ]
            );

            if (updated.affectedRows !== 1) {
                reject(
                    409,
                    "Ballot status update failed."
                );
            }

            await db.commit();
            transactionStarted = false;
        }

        const selectedBubbles = positions.reduce(
            (total, position) =>
                total + position.marked,
            0
        );

        const overvotes = positions.filter(
            position => position.overvoted
        ).length;

        const skippedPositions = positions.filter(
            position => position.result.startsWith("SKIPPED")
        ).length;

        return res.status(200).json({
            success: true,
            valid: true,
            preview_only: !counting,
            counted: counting,
            duplicate: false,
            election_id: electionId,
            template_id: templateId,
            ballot_id: qr.ballot_id,
            status: counting ? "COUNTED" : ballotStatus,
            paper_size: paperSize,
            source: {
                width: info.width,
                height: info.height
            },
            markers_detected: marks.length,
            sensitivity: "Balanced",
            selected_bubbles: selectedBubbles,
            overvotes,
            skipped_positions: skippedPositions,
            review_required: needsReview.length > 0,
            unclear_positions: needsReview.map(
                position => position.position_name
            ),
            saved_votes: counting ? votes.length : 0,
            positions,
            message: counting
                ? `Ballot counted. ${votes.length} votes saved.`
                : `Preview complete. ${votes.length} valid votes detected. Nothing saved.`
        });

    } catch (error) {
        if (db && transactionStarted) {
            try {
                await db.rollback();
                transactionStarted = false;
            } catch (rollbackError) {
                console.error(
                    "OMR rollback failed:",
                    rollbackError
                );
            }
        }

        console.error("OMR processing error:", error);

        if (error.httpStatus) {
            return fail(
                error.httpStatus,
                error.message,
                {
                    duplicate: error.duplicate === true
                }
            );
        }

        if (error.code === "ER_DUP_ENTRY") {
            return fail(
                409,
                "Duplicate vote record. No votes saved.",
                {
                    duplicate: true
                }
            );
        }

        return fail(
            500,
            "OMR processing failed. Check backend logs."
        );

    } finally {
        if (db) {
            db.release();
        }

        if (req.file?.path) {
            try {
                await fs.unlink(req.file.path);
            } catch (error) {
                console.error(
                    "OMR cleanup error:",
                    error.message
                );
            }
        }
    }
};

/* LIVE RESULTS */

exports.getLiveTallies = async (req, res) => {
    try {
        const electionId = Number(
            req.params.election_id
        );

        if (!validId(electionId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid election ID."
            });
        }

        const [elections] = await pool.execute(
            `SELECT election_id
             FROM elections
             WHERE election_id = ?
             LIMIT 1`,
            [electionId]
        );

        if (!elections.length) {
            return res.status(404).json({
                success: false,
                message: "Election not found."
            });
        }

        const [rows] = await pool.execute(
            `SELECT
                p.position_id,
                p.title AS position_name,
                c.candidate_id,
                c.name AS candidate_name,
                COUNT(DISTINCT bv.ballot_id) AS total_votes
             FROM positions p
             INNER JOIN candidates c
                ON c.position_id = p.position_id
               AND c.election_id = p.election_id
             LEFT JOIN ballot_votes bv
                ON bv.position_id = p.position_id
               AND bv.candidate_id = c.candidate_id
               AND EXISTS (
                   SELECT 1
                   FROM issued_ballots ib
                   WHERE ib.ballot_id = bv.ballot_id
                     AND ib.election_id = p.election_id
                     AND ib.status = 'COUNTED'
               )
             WHERE p.election_id = ?
             GROUP BY
                p.position_id,
                p.title,
                c.candidate_id,
                c.name
             ORDER BY
                p.position_id ASC,
                total_votes DESC,
                c.name ASC`,
            [electionId]
        );

        const tallies = rows.map(row => ({
            election_id: electionId,
            position_id: Number(row.position_id),
            position_name: row.position_name,
            candidate_id: Number(row.candidate_id),
            candidate_name: row.candidate_name,
            total_votes: Number(row.total_votes)
        }));

        return res.status(200).json({
            success: true,
            election_id: electionId,
            tallies
        });

    } catch (error) {
        console.error("Live tallies error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to load live tallies."
        });
    }
};
