"use strict";

const sharp = require("sharp");

const PATCH_SIDE = 96;
const RADIUS = 16;
const CENTER = (PATCH_SIDE - 1) / 2;
const BLOCK_SIZE = 95;

const A5 = {
    width: Math.round(148.5 * 300 / 25.4),
    height: Math.round(210 * 300 / 25.4)
};

let cvPromise;

function getOpenCV() {
    if (!cvPromise) {
        cvPromise = (async () => {
            const { loadOpenCV } = require("@opencvjs/node");
            const cv = await loadOpenCV();

            if (
                !cv ||
                typeof cv.adaptiveThreshold !== "function"
            ) {
                throw new Error(
                    "OpenCV adaptive threshold is unavailable. No votes saved."
                );
            }

            return cv;
        })().catch(error => {
            // Allow another initialization attempt after a failure.
            cvPromise = undefined;
            error.httpStatus = 503;
            throw error;
        });
    }

    return cvPromise;
}

function project(H, x, y) {
    const d = H[6] * x + H[7] * y + 1;

    if (
        !Number.isFinite(d) ||
        Math.abs(d) < 1e-10
    ) {
        return null;
    }

    const point = {
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

    return (
        Number.isFinite(point.x) &&
        Number.isFinite(point.y)
    ) ? point : null;
}

function sample(image, point) {
    if (
        !point ||
        point.x < 0 ||
        point.y < 0 ||
        point.x >= image.width - 1 ||
        point.y >= image.height - 1
    ) {
        return null;
    }

    const x = Math.floor(point.x);
    const y = Math.floor(point.y);

    const dx = point.x - x;
    const dy = point.y - y;

    const index = y * image.width + x;

    const top =
        image.data[index] * (1 - dx) +
        image.data[index + 1] * dx;

    const bottom =
        image.data[index + image.width] * (1 - dx) +
        image.data[index + image.width + 1] * dx;

    return top * (1 - dy) + bottom * dy;
}

function percentile(values, fraction) {
    const sorted = [...values].sort((a, b) => a - b);

    const index = Math.min(
        sorted.length - 1,
        Math.floor((sorted.length - 1) * fraction)
    );

    return sorted[index];
}

/*
 * SHADOW CHANGE:
 * Estimate paper brightness around each bubble using a local plane.
 *
 * Bright percentiles reduce contamination from neighboring printing.
 * Large residuals indicate a hard shadow edge or background interference.
 */
function paperPlane(sectors) {
    const points = sectors
        .filter(sector => sector.values.length >= 5)
        .map(sector => ({
            x: sector.x / sector.values.length,
            y: sector.y / sector.values.length,
            value: percentile(sector.values, 0.70)
        }));

    if (points.length < 10) {
        throw new Error(
            "Insufficient paper samples. Keep the complete ballot visible."
        );
    }

    const matrix = Array.from(
        { length: 3 },
        () => [0, 0, 0, 0]
    );

    for (const point of points) {
        const row = [1, point.x, point.y];

        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                matrix[i][j] += row[i] * row[j];
            }

            matrix[i][3] += row[i] * point.value;
        }
    }

    for (let i = 0; i < 3; i++) {
        let pivot = i;

        for (let j = i + 1; j < 3; j++) {
            if (
                Math.abs(matrix[j][i]) >
                Math.abs(matrix[pivot][i])
            ) {
                pivot = j;
            }
        }

        [matrix[i], matrix[pivot]] = [
            matrix[pivot],
            matrix[i]
        ];

        if (Math.abs(matrix[i][i]) < 1e-8) {
            throw new Error(
                "Invalid local paper geometry."
            );
        }

        const divisor = matrix[i][i];

        for (let j = i; j < 4; j++) {
            matrix[i][j] /= divisor;
        }

        for (let j = 0; j < 3; j++) {
            if (j === i) continue;

            const factor = matrix[j][i];

            for (let k = i; k < 4; k++) {
                matrix[j][k] -= factor * matrix[i][k];
            }
        }
    }

    const plane = matrix.map(row => row[3]);

    const residual = percentile(
        points.map(point => Math.abs(
            point.value -
            (
                plane[0] +
                plane[1] * point.x +
                plane[2] * point.y
            )
        )),
        0.90
    );

    return { plane, residual };
}

function locateBubbleCenter(image, H, coordinate) {
    const x = Number(coordinate.x_pos);
    const y = Number(coordinate.y_pos);
    const w = Number(coordinate.width);
    const h = Number(coordinate.height);

    const cx = x + w / 2;
    const cy = y + h / 2;

    const center = project(H, cx, cy);
    const left = project(H, x, cy);
    const right = project(H, x + w, cy);
    const top = project(H, cx, y);
    const bottom = project(H, cx, y + h);

    if (![center, left, right, top, bottom].every(Boolean)) {
        throw new Error("Invalid bubble projection.");
    }

    const diameter = Math.min(
        Math.hypot(right.x - left.x, right.y - left.y),
        Math.hypot(bottom.x - top.x, bottom.y - top.y)
    );

    const range = Math.min(
        18,
        Math.max(3, Math.round(diameter * 0.48))
    );
    const step = Math.max(1, Math.round(diameter / 16));
    const ring = [];

    for (let i = 0; i < 32; i++) {
        const angle = i * 2 * Math.PI / 32;
        const edge = project(
            H,
            cx + Math.cos(angle) * w / 2,
            cy + Math.sin(angle) * h / 2
        );

        if (!edge) {
            throw new Error("Invalid bubble outline.");
        }

        ring.push({
            x: edge.x - center.x,
            y: edge.y - center.y
        });
    }

    let best = { dx: 0, dy: 0, score: -Infinity };

    for (let dy = -range; dy <= range; dy += step) {
        for (let dx = -range; dx <= range; dx += step) {
            const differences = [];
            let total = 0;
            let valid = true;

            for (const v of ring) {
                const inner = sample(image, {
                    x: center.x + dx + v.x * 0.96,
                    y: center.y + dy + v.y * 0.96
                });

                const outer = sample(image, {
                    x: center.x + dx + v.x * 1.25,
                    y: center.y + dy + v.y * 1.25
                });

                if (inner === null || outer === null) {
                    valid = false;
                    break;
                }

                const difference = outer - inner;
                differences.push(difference);

                total += Math.max(
                    -100,
                    Math.min(200, difference)
                );
            }

            if (!valid) continue;

            differences.sort((a, b) => a - b);

            const median =
                (differences[15] + differences[16]) / 2;

            const score =
                0.4 * median +
                0.6 * total / 32 -
                0.07 * Math.hypot(dx, dy);

            if (score > best.score) {
                best = { dx, dy, score };
            }
        }
    }

    return best;
}

/*
 * HOMOGRAPHY CHANGE:
 * Sample a canonical patch through the same homography used by markers.
 *
 * Each bubble becomes 32 pixels wide in a 96 x 96 patch.
 * This makes adaptive-threshold window size independent of camera resolution.
 */
function canonicalPatch(image, H, coordinate, paper) {
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
        x + w > paper.width ||
        y + h > paper.height
    ) {
        throw new Error(
            "Invalid saved bubble coordinates."
        );
    }

    const cx = x + w / 2;
    const cy = y + h / 2;
    const alignment = locateBubbleCenter(
        image, H, coordinate
    );

    if (alignment.score < 20) {
        throw new Error(
            "Bubble outline alignment is uncertain. " +
            "Retake a clear, well-lit ballot photo."
        );
    }
    const raw = new Float32Array(
        PATCH_SIDE * PATCH_SIDE
    );

    const valid = new Uint8Array(raw.length);

    const sectors = Array.from(
        { length: 12 },
        () => ({
            values: [],
            x: 0,
            y: 0
        })
    );

    for (let py = 0; py < PATCH_SIDE; py++) {
        for (let px = 0; px < PATCH_SIDE; px++) {
            const nx = (px - CENTER) / RADIUS;
            const ny = (py - CENTER) / RADIUS;

            const sourcePoint = project(
                H,
                cx + nx * w / 2,
                cy + ny * h / 2
            );

            if (sourcePoint) {
                sourcePoint.x += alignment.dx;
                sourcePoint.y += alignment.dy;
            }

            const value = sample(image, sourcePoint);

            const index = py * PATCH_SIDE + px;

            raw[index] = value === null ? 255 : value;
            valid[index] = value === null ? 0 : 1;

            const radius = Math.hypot(nx, ny);

            if (
                radius <= 0.70 &&
                value === null
            ) {
                throw new Error(
                    "A bubble is outside the image. Retake the complete ballot."
                );
            }

            // Sample paper immediately outside the printed bubble.
            if (
                value !== null &&
                radius >= 1.14 &&
                radius <= 1.42
            ) {
                const sectorIndex = Math.min(
                    11,
                    Math.floor(
                        (Math.atan2(ny, nx) + Math.PI) *
                        12 / (2 * Math.PI)
                    )
                );

                const sector = sectors[sectorIndex];

                sector.values.push(value);
                sector.x += nx;
                sector.y += ny;
            }
        }
    }

    const { plane, residual } = paperPlane(sectors);

    const normalized = new Uint8Array(raw.length);

    for (let py = 0; py < PATCH_SIDE; py++) {
        for (let px = 0; px < PATCH_SIDE; px++) {
            const index = py * PATCH_SIDE + px;

            const nx = (px - CENTER) / RADIUS;
            const ny = (py - CENTER) / RADIUS;

            const reference = Math.max(
                30,
                Math.min(
                    255,
                    plane[0] +
                    plane[1] * nx +
                    plane[2] * ny
                )
            );

            normalized[index] = valid[index]
                ? Math.min(
                    255,
                    Math.round(
                        raw[index] * 255 / reference
                    )
                )
                : 255;
        }
    }

    const edges = [
        project(H, x, cy),
        project(H, x + w, cy),
        project(H, cx, y),
        project(H, cx, y + h)
    ];

    if (edges.some(point => !point)) {
        throw new Error(
            "Invalid projected bubble geometry."
        );
    }

    const projectedDiameter = Math.min(
        Math.hypot(
            edges[1].x - edges[0].x,
            edges[1].y - edges[0].y
        ),
        Math.hypot(
            edges[3].x - edges[2].x,
            edges[3].y - edges[2].y
        )
    );

    return {
        normalized,
        baseline: plane[0],
        residual,
        projectedDiameter
    };
}


function measurement(patch, binary, coordinate) {
    let total = 0;
    let dark = 0;
    let weak = 0;
    let adaptive = 0;
    let contrast = 0;
    let core = 0;
    let coreDark = 0;

    for (let y = 0; y < PATCH_SIDE; y++) {
        for (let x = 0; x < PATCH_SIDE; x++) {
            const radius = Math.hypot(
                (x - CENTER) / RADIUS,
                (y - CENTER) / RADIUS
            );

            // Measure inside the bubble,
            // excluding the printed outline.
            if (radius > 0.70) continue;

            const index = y * PATCH_SIDE + x;

            const difference = Math.max(
                0,
                255 - patch.normalized[index]
            );

            total++;
            contrast += difference;

            if (difference >= 35) dark++;
            if (difference >= 14) weak++;
            if (binary[index] > 0) adaptive++;

            if (radius <= 0.35) {
                core++;

                if (difference >= 35) {
                    coreDark++;
                }
            }
        }
    }

    const average = contrast / total;
    const marked = dark / total;
    const adaptiveMarked = adaptive / total;

    const quality = [];

    if (patch.projectedDiameter < 12) {
        quality.push("LOW_BUBBLE_RESOLUTION");
    }

    if (patch.baseline < 45) {
        quality.push("UNDEREXPOSED_PAPER");
    }

    if (
        patch.residual >
        Math.max(18, patch.baseline * 0.12)
    ) {
        quality.push(
            "HARD_SHADOW_OR_BACKGROUND_INTERFERENCE"
        );
    }

    // Keep strict conditions for SHADED votes.
    const selected =
        quality.length === 0 &&
        average >= 34 &&
        marked >= 0.58 &&
        adaptiveMarked >= 0.50 &&
        coreDark / core >= 0.30;

    /*
     * BLANK DETECTION FIX
     *
     * The original weak-contrast condition incorrectly
     * identified some empty circles as UNCLEAR.
     *
     * Classify a clean, near-white bubble as BLANK.
     * Poor-quality images must still require review.
     */
    const cleanBlank =
        quality.length === 0 &&
        average < 20 &&
        marked < 0.08 &&
        adaptiveMarked < 0.08;

    const unclear =
        !selected &&
        !cleanBlank &&
        (
            quality.length > 0 ||
            (
                average >= 12 &&
                weak / total >= 0.20
            ) ||
            marked >= 0.20 ||
            adaptiveMarked >= 0.20
        );

    if (unclear && quality.length === 0) {
        quality.push(
            "AMBIGUOUS_SHADING_OR_METHOD_DISAGREEMENT"
        );
    }

    return {
        candidate_id: Number(coordinate.candidate_id),
        candidate_name: coordinate.candidate_name,
        position_id: Number(coordinate.position_id),

        selected,
        unclear,

        average,
        marked,
        baseline: patch.baseline,

        adaptive_dark_percent:
            Math.round(adaptiveMarked * 10000) / 100,

        adaptive_marked: adaptiveMarked,
        core_marked: coreDark / core,
        samples: total,

        projected_diameter:
            Math.round(patch.projectedDiameter * 100) / 100,

        background_residual:
            Math.round(patch.residual * 100) / 100,

        quality_reasons: quality
    };
}

/*
 * MAIN PIPELINE CHANGE:
 * Called for actual counting and preview.
 * OpenCV failures propagate; there is no legacy-counting fallback.
 */
async function analyzeBubbles(
    image,
    H,
    coordinates,
    paper = A5
) {
    if (
        !image ||
        !Number.isSafeInteger(image.width) ||
        !Number.isSafeInteger(image.height) ||
        image.width < 2 ||
        image.height < 2 ||
        !image.data ||
        image.data.length !== image.width * image.height ||
        (
            image.channels !== undefined &&
            image.channels !== 1
        )
    ) {
        throw new Error(
            "Expected one-channel grayscale ballot pixels."
        );
    }

    if (
        !Array.isArray(H) ||
        H.length !== 8 ||
        !H.every(Number.isFinite)
    ) {
        throw new Error(
            "Invalid ballot alignment."
        );
    }

    if (
        !Array.isArray(coordinates) ||
        !coordinates.length ||
        !paper ||
        !Number.isFinite(paper.width) ||
        !Number.isFinite(paper.height)
    ) {
        throw new Error(
            "Missing ballot coordinates or dimensions."
        );
    }

    const ids = new Set();

    for (const coordinate of coordinates) {
        const id = Number(coordinate.candidate_id);

        if (
            !Number.isSafeInteger(id) ||
            id <= 0 ||
            ids.has(id)
        ) {
            throw new Error(
                "Invalid or duplicate candidate coordinates."
            );
        }

        ids.add(id);
    }

    const cv = await getOpenCV();

    let src;
    let binary;

    try {
        src = new cv.Mat(
            PATCH_SIDE,
            PATCH_SIDE,
            cv.CV_8UC1
        );

        binary = new cv.Mat();

        const candidates = [];

        for (const coordinate of coordinates) {
            const patch = canonicalPatch(
                image,
                H,
                coordinate,
                paper
            );

            src.data.set(patch.normalized);

            /*
             * A 95px window includes paper around the 32px bubble.
             * This avoids treating a solid dark bubble center as background.
             */
            cv.adaptiveThreshold(
                src,
                binary,
                255,
                cv.ADAPTIVE_THRESH_GAUSSIAN_C,
                cv.THRESH_BINARY_INV,
                BLOCK_SIZE,
                12
            );

            candidates.push(
                measurement(
                    patch,
                    binary.data,
                    coordinate
                )
            );
        }

        return {
            method: "opencv_adaptive_threshold",
            width: image.width,
            height: image.height,
            canonical_patch_size: PATCH_SIDE,
            block_size: BLOCK_SIZE,
            candidates
        };
    } finally {
        if (binary) binary.delete();
        if (src) src.delete();
    }
}

/*
 * Compatibility with older preview callers.
 * The main controller passes its already decoded working image.
 */
async function analyzePreview(
    imageOrPath,
    H,
    coordinates,
    paper = A5
) {
    if (typeof imageOrPath !== "string") {
        return analyzeBubbles(
            imageOrPath,
            H,
            coordinates,
            paper
        );
    }

    const { data, info } = await sharp(imageOrPath)
        .rotate()
        .flatten({ background: "white" })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    return analyzeBubbles(
        {
            data,
            width: info.width,
            height: info.height,
            channels: 1
        },
        H,
        coordinates,
        paper
    );
}

module.exports = {
    analyzeBubbles,
    analyzePreview
};