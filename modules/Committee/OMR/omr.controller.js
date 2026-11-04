
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

// Basahin ang original photo bilang grayscale.
async function readOMRImage(imagePath) {
    const result = await sharp(imagePath)
        .rotate()
        .grayscale()
        .raw()
        .toBuffer({
            resolveWithObject: true
        });

    const { width, height } = result.info;

    if (
        width < 500 ||
        height < 700 ||
        result.data.length !== width * height
    ) {
        throw new Error(
            "Image resolution is too low or invalid. " +
            "Retake a clearer A5 ballot photo."
        );
    }

    return {
        data: result.data,
        width,
        height
    };
}

// Sukatin ang exposure ng original photo.
function measureImageExposure(image) {
    const { data } = image;

    let darkPixels = 0;
    let brightPixels = 0;

    for (let i = 0; i < data.length; i++) {
        if (data[i] <= 5) {
            darkPixels++;
        }

        if (data[i] >= 250) {
            brightPixels++;
        }
    }

    return {
        dark_ratio: darkPixels / data.length,
        bright_ratio: brightPixels / data.length
    };
}

// I-correct ang shadows nang hindi sobrang pinapaputi
// ang light pencil shading.
async function normalizeOMRLighting(input) {
    const original = typeof input === "string"
        ? await readOMRImage(input)
        : input;

    if (
        !original ||
        !Buffer.isBuffer(original.data) ||
        !Number.isSafeInteger(original.width) ||
        !Number.isSafeInteger(original.height) ||
        original.data.length !==
        original.width * original.height
    ) {
        throw new Error(
            "Invalid image supplied for lighting correction."
        );
    }

    const { width, height } = original;

    const radius = Math.max(
        3,
        Math.min(
            60,
            Math.round(Math.min(width, height) / 35)
        )
    );

    // Estimate ang local background brightness.
    const background = await sharp(
        original.data,
        {
            raw: {
                width,
                height,
                channels: 1
            }
        }
    )
        .blur(radius)
        .raw()
        .toBuffer();

    const normalized = Buffer.allocUnsafe(
        width * height
    );

    const quality = measureImageExposure(original);

    // Blend ang original at corrected pixels.
    // Para hindi mawala agad ang mahihinang shading.
    const correctionStrength = 0.40;
    const targetBrightness = 205;

    for (let i = 0; i < normalized.length; i++) {
        const pixel = original.data[i];
        const localLight = background[i];

        const corrected =
            targetBrightness +
            (pixel - localLight) * 1.15;

        const blended =
            pixel * (1 - correctionStrength) +
            corrected * correctionStrength;

        normalized[i] = Math.max(
            0,
            Math.min(
                255,
                Math.round(blended)
            )
        );
    }

    return {
        data: normalized,
        width,
        height,
        quality
    };
}

// Kumuha ng grayscale pixel gamit ang bilinear sampling.
function sampleGrayBilinear(image, x, y) {
    if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= image.width - 1 ||
        y >= image.height - 1
    ) {
        return null;
    }

    const x0 = Math.floor(x);
    const y0 = Math.floor(y);

    const fx = x - x0;
    const fy = y - y0;

    const index = y0 * image.width + x0;

    const p00 = image.data[index];
    const p10 = image.data[index + 1];
    const p01 = image.data[index + image.width];
    const p11 = image.data[index + image.width + 1];

    const top = p00 * (1 - fx) + p10 * fx;
    const bottom = p01 * (1 - fx) + p11 * fx;

    return Math.round(
        top * (1 - fy) + bottom * fy
    );
}

// I-validate ang four registration markers.
function validateMarkerQuadrilateral(marks) {
    if (
        !Array.isArray(marks) ||
        marks.length !== 4 ||
        !marks.every(point =>
            point &&
            Number.isFinite(point.x) &&
            Number.isFinite(point.y)
        )
    ) {
        throw new Error(
            "Four valid registration markers are required."
        );
    }

    const [tl, tr, bl, br] = marks;

    const distance = (a, b) =>
        Math.hypot(
            a.x - b.x,
            a.y - b.y
        );

    const top = distance(tl, tr);
    const bottom = distance(bl, br);
    const left = distance(tl, bl);
    const right = distance(tr, br);

    if (
        Math.min(top, bottom, left, right) < 100
    ) {
        throw new Error(
            "Registration markers are too close together."
        );
    }

    const cross = (a, b, c) =>
        (b.x - a.x) * (c.y - a.y) -
        (b.y - a.y) * (c.x - a.x);

    const polygon = [tl, tr, br, bl];

    const turns = polygon.map((point, i) =>
        cross(
            point,
            polygon[(i + 1) % 4],
            polygon[(i + 2) % 4]
        )
    );

    if (
        turns.some(value => Math.abs(value) < 1) ||
        !turns.every(value => value > 0) &&
        !turns.every(value => value < 0)
    ) {
        throw new Error(
            "Registration markers do not form " +
            "a valid ballot quadrilateral."
        );
    }

    const measuredRatio =
        ((top + bottom) / 2) /
        ((left + right) / 2);

    const expectedRatio =
        (138.5 - 9.5) /
        (200.5 - 7.5);

    if (
        !Number.isFinite(measuredRatio) ||
        Math.abs(measuredRatio - expectedRatio) > 0.22 ||
        Math.abs(top - bottom) /
        Math.max(top, bottom) > 0.35 ||
        Math.abs(left - right) /
        Math.max(left, right) > 0.35
    ) {
        throw new Error(
            "Registration markers do not match " +
            "one A5 portrait ballot."
        );
    }

    return true;
}

// Gumawa ng perspective-corrected A5 image.
// Marker-based ang alignment, hindi manual crop.
function rectifyA5Ballot(image, marks) {
    validateMarkerQuadrilateral(marks);

    const paper = PAPER_DIMENSIONS.A5;

    const markerPoints = [
        { x: mm(9.5), y: mm(7.5) },
        { x: mm(138.5), y: mm(7.5) },
        { x: mm(9.5), y: mm(200.5) },
        { x: mm(138.5), y: mm(200.5) }
    ];

    // Existing homography() at project() functions
    // ay nasa kasunod na section ng controller.
    const H = homography(markerPoints, marks);

    const output = Buffer.alloc(
        paper.width * paper.height,
        255
    );

    let missingSamples = 0;

    // Map each A5 pixel pabalik sa original photo.
    for (let y = 0; y < paper.height; y++) {
        const row = y * paper.width;

        for (let x = 0; x < paper.width; x++) {
            const point = project(H, x, y);

            const value = point
                ? sampleGrayBilinear(
                    image,
                    point.x,
                    point.y
                )
                : null;

            if (value === null) {
                missingSamples++;
                continue;
            }

            output[row + x] = value;
        }
    }

    const missingRatio =
        missingSamples / output.length;

    // Huwag magbilang kapag maraming image pixels
    // ang wala sa captured photo.
    if (missingRatio > 0.005) {
        throw new Error(
            "Part of the A5 ballot is outside the photo. " +
            "Retake with the entire paper visible."
        );
    }

    return {
        data: output,
        width: paper.width,
        height: paper.height,
        quality: {
            missing_ratio: missingRatio
        },
        markers: markerPoints,
        homography: H
    };
}

// Convert ang corrected grayscale ballot to JPEG.
// Para sa preview endpoint sa susunod na parts.
async function encodeCorrectedBallot(image) {
    if (
        !image ||
        !image.data ||
        !Number.isSafeInteger(image.width) ||
        !Number.isSafeInteger(image.height) ||
        image.data.length !== image.width * image.height
    ) {
        throw new Error(
            "Invalid corrected ballot image."
        );
    }

    return sharp(
        image.data,
        {
            raw: {
                width: image.width,
                height: image.height,
                channels: 1
            }
        }
    )
        .jpeg({
            quality: 92,
            mozjpeg: true
        })
        .toBuffer();
}

function parseQR(qrData) {
    const parts = String(qrData || "")
        .trim()
        .split("|");

    const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// Basahin ang QR sa isang image buffer.
function decodeQRBuffer(data, width, height) {
    if (
        !data ||
        width < 21 ||
        height < 21 ||
        data.length !== width * height * 4
    ) {
        return null;
    }

    const result = jsQR(
        new Uint8ClampedArray(data),
        width,
        height,
        {
            inversionAttempts: "attemptBoth"
        }
    );

    if (
        !result ||
        typeof result.data !== "string" ||
        !result.data.trim()
    ) {
        return null;
    }

    // I-validate ang QR format bago tanggapin.
    try {
        return parseQR(result.data);
    } catch (_) {
        return null;
    }
}

// Convert grayscale to RGBA para sa jsQR.
async function grayscaleToQRImage(image) {
    const result = await sharp(
        image.data,
        {
            raw: {
                width: image.width,
                height: image.height,
                channels: 1
            }
        }
    )
        .ensureAlpha()
        .raw()
        .toBuffer({
            resolveWithObject: true
        });

    return {
        data: result.data,
        width: result.info.width,
        height: result.info.height
    };
}

// Subukan ang iba't ibang image sizes.


async function scanQRAtMultipleSizes(imageBuffer) {
    const metadata = await sharp(imageBuffer).metadata();

    const width = metadata.width;
    const height = metadata.height;

    if (!width || !height) {
        return null;
    }

    // Mas maliit na full image, mas malaking QR crop.
    const targetWidths = [
        Math.min(width, 1400),
        Math.min(width, 900)
    ];

    if (width <= 1000) {
        targetWidths.push(Math.min(width * 2, 1800));
    }

    const sizes = [...new Set(targetWidths)];

    for (const targetWidth of sizes) {
        for (const mode of ["original", "normalize"]) {
            let pipeline = sharp(imageBuffer)
                .resize({
                    width: targetWidth,
                    kernel: "lanczos3"
                })
                .grayscale();

            // Subukan ang contrast correction.
            if (mode === "normalize") {
                pipeline = pipeline.normalize();
            }

            // Subukan ang black-and-white QR.
            if (mode === "threshold") {
                pipeline = pipeline.normalize().threshold(145);
            }

            const result = await pipeline
                .ensureAlpha()
                .raw()
                .toBuffer({
                    resolveWithObject: true
                });

            const decoded = decodeQRBuffer(
                result.data,
                result.info.width,
                result.info.height
            );

            if (decoded) {
                return decoded;
            }
        }
    }

    return null;
}


// Hanapin ang QR sa full image at upper-right.

async function scanQRRegions(imageBuffer) {
    const metadata = await sharp(imageBuffer).metadata();

    const width = metadata.width;
    const height = metadata.height;

    if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 100 ||
        height < 100
    ) {
        return null;
    }

    // Unahin ang upper-right dahil dito naka-print ang QR.
    const regions = [
        { left: 0.55, top: 0.00, right: 1.00, bottom: 0.45 },
        { left: 0.65, top: 0.00, right: 1.00, bottom: 0.35 },
        { left: 0.50, top: 0.00, right: 1.00, bottom: 0.55 },
        { left: 0.60, top: 0.03, right: 0.98, bottom: 0.30 }
    ];

    for (const region of regions) {
        const left = Math.floor(width * region.left);
        const top = Math.floor(height * region.top);
        const right = Math.ceil(width * region.right);
        const bottom = Math.ceil(height * region.bottom);

        const cropWidth = right - left;
        const cropHeight = bottom - top;

        if (cropWidth < 100 || cropHeight < 100) {
            continue;
        }

        const cropped = await sharp(imageBuffer)
            .extract({
                left,
                top,
                width: cropWidth,
                height: cropHeight
            })
            .png()
            .toBuffer();

        const decoded = await scanQRAtMultipleSizes(cropped);

        if (decoded) {
            return decoded;
        }
    }

    // Full image fallback kung hindi nakita sa upper-right.
    return await scanQRAtMultipleSizes(imageBuffer);
}


// Original photo muna, corrected image bilang fallback.

async function readBallotQR(imagePath, correctedImage = null) {
    // Ayusin ang orientation ng photo mula sa iPhone.
    const originalBuffer = await sharp(imagePath)
        .rotate()
        .png()
        .toBuffer();

    // Unahin ang original photo.
    let result = await scanQRRegions(originalBuffer);

    if (result) {
        return result;
    }

    // Subukan ang perspective-corrected A5 ballot.
    if (correctedImage) {
        const correctedBuffer = await sharp(
            correctedImage.data,
            {
                raw: {
                    width: correctedImage.width,
                    height: correctedImage.height,
                    channels: 1
                }
            }
        )
            .png()
            .toBuffer();

        result = await scanQRRegions(correctedBuffer);

        if (result) {
            return result;
        }
    }

    // Huling attempt: lighting-corrected original.
    const normalized = await normalizeOMRLighting(imagePath);

    const normalizedBuffer = await sharp(
        normalized.data,
        {
            raw: {
                width: normalized.width,
                height: normalized.height,
                channels: 1
            }
        }
    )
        .png()
        .toBuffer();

    result = await scanQRRegions(normalizedBuffer);

    if (result) {
        return result;
    }

    // Walang valid QR, kaya bawal mag-count.
    throw new Error(
        "QR code not detected. Retake a clearer photo " +
        "with the entire A5 ballot visible. No votes recorded."
    );
}


// taga kuha ng template at original bubble coordinates.


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

// Hanapin ang apat na registration squares sa A5 photo.
async function findMarkers(
    normalizedImage,
    originalWidth,
    originalHeight
) {
    if (
        !normalizedImage ||
        !normalizedImage.data ||
        !validId(normalizedImage.width) ||
        !validId(normalizedImage.height) ||
        normalizedImage.data.length !==
        normalizedImage.width * normalizedImage.height
    ) {
        throw new Error("Invalid image for marker detection.");
    }

    const scale = Math.min(
        1,
        1500 / Math.max(
            normalizedImage.width,
            normalizedImage.height
        )
    );

    const w = Math.round(normalizedImage.width * scale);
    const h = Math.round(normalizedImage.height * scale);

    const resized = await sharp(
        normalizedImage.data,
        {
            raw: {
                width: normalizedImage.width,
                height: normalizedImage.height,
                channels: 1
            }
        }
    )
        .resize(w, h)
        .raw()
        .toBuffer({ resolveWithObject: true });

    const data = resized.data;

    // Subukan ang ilang thresholds para sa shadows.
    const thresholds = [90, 125, 165];
    const candidates = [];

    for (const threshold of thresholds) {
        const mask = new Uint8Array(w * h);
        const seen = new Uint8Array(w * h);

        for (let i = 0; i < mask.length; i++) {
            mask[i] = data[i] < threshold ? 1 : 0;
        }

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const start = y * w + x;

                if (!mask[start] || seen[start]) {
                    continue;
                }

                const stack = [start];
                seen[start] = 1;

                let area = 0;
                let sumX = 0;
                let sumY = 0;
                let minX = x;
                let maxX = x;
                let minY = y;
                let maxY = y;

                // Connected-component detection.
                while (stack.length) {
                    const index = stack.pop();
                    const px = index % w;
                    const py = Math.floor(index / w);

                    area++;
                    sumX += px;
                    sumY += py;

                    minX = Math.min(minX, px);
                    maxX = Math.max(maxX, px);
                    minY = Math.min(minY, py);
                    maxY = Math.max(maxY, py);

                    const neighbors = [];

                    if (px > 0) {
                        neighbors.push(index - 1);
                    }

                    if (px + 1 < w) {
                        neighbors.push(index + 1);
                    }

                    if (py > 0) {
                        neighbors.push(index - w);
                    }

                    if (py + 1 < h) {
                        neighbors.push(index + w);
                    }

                    for (const next of neighbors) {
                        if (mask[next] && !seen[next]) {
                            seen[next] = 1;
                            stack.push(next);
                        }
                    }
                }

                const bw = maxX - minX + 1;
                const bh = maxY - minY + 1;
                const ratio = bw / bh;
                const density = area / (bw * bh);

                // Reject text, lines at malalaking shadows.
                if (
                    area < 10 ||
                    bw < 3 ||
                    bh < 3 ||
                    bw > w * 0.065 ||
                    bh > h * 0.065 ||
                    ratio < 0.60 ||
                    ratio > 1.65 ||
                    density < 0.60
                ) {
                    continue;
                }

                const cx = sumX / area;
                const cy = sumY / area;

                // Registration squares dapat nasa outer
                // region ng ballot, hindi sa gitna.
                const nearLeft = cx < w * 0.43;
                const nearRight = cx > w * 0.57;
                const nearTop = cy < h * 0.43;
                const nearBottom = cy > h * 0.57;

                if (
                    !(nearLeft || nearRight) ||
                    !(nearTop || nearBottom)
                ) {
                    continue;
                }

                // Merge candidates mula sa iba-ibang thresholds.
                const duplicate = candidates.some(item =>
                    Math.hypot(
                        item.x - cx,
                        item.y - cy
                    ) < Math.max(5, Math.min(bw, bh) * 0.5)
                );

                if (duplicate) {
                    continue;
                }

                candidates.push({
                    x: cx,
                    y: cy,
                    width: bw,
                    height: bh,
                    area,
                    density,
                    score: density * Math.min(bw, bh)
                });
            }
        }
    }

    // Hatiin sa apat na regions.
    const regions = [
        candidates.filter(p =>
            p.x < w * 0.5 && p.y < h * 0.5
        ),
        candidates.filter(p =>
            p.x >= w * 0.5 && p.y < h * 0.5
        ),
        candidates.filter(p =>
            p.x < w * 0.5 && p.y >= h * 0.5
        ),
        candidates.filter(p =>
            p.x >= w * 0.5 && p.y >= h * 0.5
        )
    ];

    if (regions.some(region => region.length === 0)) {
        throw new Error(
            "Four registration squares not detected. " +
            "Retake with all four corners visible."
        );
    }

    // Unahin ang mas malalaking, solid na squares.
    const shortlist = regions.map(region =>
        region
            .sort((a, b) => b.score - a.score)
            .slice(0, 12)
    );

    const expectedRatio =
        (138.5 - 9.5) / (200.5 - 7.5);

    const distance = (a, b) =>
        Math.hypot(a.x - b.x, a.y - b.y);

    let best = null;
    let bestScore = -Infinity;
    let secondBestScore = -Infinity;

    // Piliin ang best matching four-marker group.
    for (const tl of shortlist[0]) {
        for (const tr of shortlist[1]) {
            for (const bl of shortlist[2]) {
                for (const br of shortlist[3]) {
                    const top = distance(tl, tr);
                    const bottom = distance(bl, br);
                    const left = distance(tl, bl);
                    const right = distance(tr, br);

                    const minSide = Math.min(
                        top, bottom, left, right
                    );

                    if (
                        minSide < Math.min(w, h) * 0.30
                    ) {
                        continue;
                    }

                    const ratio =
                        ((top + bottom) / 2) /
                        ((left + right) / 2);

                    const widthDifference =
                        Math.abs(top - bottom) /
                        Math.max(top, bottom);

                    const heightDifference =
                        Math.abs(left - right) /
                        Math.max(left, right);

                    if (
                        Math.abs(ratio - expectedRatio) > 0.22 ||
                        widthDifference > 0.35 ||
                        heightDifference > 0.35
                    ) {
                        continue;
                    }

                    const points = [tl, tr, bl, br];

                    try {
                        validateMarkerQuadrilateral(points);
                    } catch (_) {
                        continue;
                    }

                    const sizes = points.map(p =>
                        Math.sqrt(p.width * p.height)
                    );

                    const minSize = Math.min(...sizes);
                    const maxSize = Math.max(...sizes);

                    if (
                        minSize < 4 ||
                        maxSize / minSize > 2.5
                    ) {
                        continue;
                    }

                    const areaScore =
                        points.reduce(
                            (sum, p) => sum + p.score,
                            0
                        );

                    const geometryPenalty =
                        Math.abs(ratio - expectedRatio) * 100 +
                        widthDifference * 50 +
                        heightDifference * 50;

                    const sizePenalty =
                        (maxSize / minSize - 1) * 10;

                    const score =
                        areaScore -
                        geometryPenalty -
                        sizePenalty;

                    if (score > bestScore) {
                        secondBestScore = bestScore;
                        bestScore = score;
                        best = points;
                    } else if (score > secondBestScore) {
                        secondBestScore = score;
                    }
                }
            }
        }
    }

    if (!best) {
        throw new Error(
            "Registration markers found, but alignment " +
            "does not match an A5 portrait ballot."
        );
    }
    const marks = best.map(point => ({
        x: point.x / scale,
        y: point.y / scale
    }));

    validateMarkerQuadrilateral(marks);

    return marks;
}

// Solve ang eight homography parameters.


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

// Map template coordinates papunta sa photo.
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

// Project coordinates gamit ang homography.
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

// Sample ng original image pixel.
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

// OMR BUBBLE DETECTION

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

    // Sukatin ang loob, iwas sa printed outline.
    for (let j = -16; j <= 16; j++) {
        for (let i = -16; i <= 16; i++) {
            const r = Math.hypot(i / 16, j / 16);

            if (r > 0.65) continue;

            const value = sample(
                image,
                H,
                cx + (i / 16) * w * 0.42,
                cy + (j / 16) * h * 0.42
            );

            if (value !== null) {
                inside.push(value);
            }
        }
    }

    // Nearby paper ang brightness reference.
    for (let j = -20; j <= 20; j++) {
        for (let i = -20; i <= 20; i++) {
            const r = Math.hypot(i / 20, j / 20);

            if (r < 0.78 || r > 1) continue;

            const value = sample(
                image,
                H,
                cx + (i / 20) * w * 0.95,
                cy + (j / 20) * h * 0.95
            );

            if (value !== null) {
                paper.push(value);
            }
        }
    }

    // Kapag kulang ang samples, retake muna.
    if (inside.length < 80 || paper.length < 20) {
        throw new Error(
            "Insufficient bubble samples. Retake the photo."
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

    // Initial thresholds, kailangan ng real-ballot calibration.
    const settings = {
        1: {
            contrast: 30,
            minimum: 21,
            requiredMarked: 0.32,
            uncertainAverage: 10,
            uncertainMarked: 0.12
        },
        2: {
            contrast: 20,
            minimum: 13,
            requiredMarked: 0.24,
            uncertainAverage: 7,
            uncertainMarked: 0.10
        },
        3: {
            contrast: 13,
            minimum: 8,
            requiredMarked: 0.19,
            uncertainAverage: 5,
            uncertainMarked: 0.08
        }
    };

    const setting = settings[sensitivity] || settings[2];

    const marked = differences.filter(
        value => value > setting.contrast
    ).length / differences.length;

    const selected =
        average >= setting.minimum &&
        marked >= setting.requiredMarked;

    // Borderline shading, hindi agad blank.
    const possibleShade =
        average >= setting.uncertainAverage &&
        marked >= setting.uncertainMarked;

    const unclear = !selected && possibleShade;

    const sortedInside = [...inside].sort((a, b) => a - b);

    const p10 = sortedInside[
        Math.floor((sortedInside.length - 1) * 0.10)
    ];

    const p90 = sortedInside[
        Math.floor((sortedInside.length - 1) * 0.90)
    ];

    const localContrast = p90 - p10;

    return {
        selected,
        unclear,
        average,
        marked,
        baseline,
        localContrast,
        confidence: selected
            ? "SELECTED"
            : unclear
                ? "UNCERTAIN"
                : "BLANK"
    };
}

/* POSITION VOTE VALIDATION */

function validatePositionVotes(grouped) {
    const positions = [...grouped.values()].map(position => {
        const markedCandidates = position.candidates.filter(
            candidate => candidate.filled
        );

        const marked = markedCandidates.length;
        const overvoted = marked > position.max_selection;

        const unclear = position.candidates.some(
            candidate => candidate.unclear
        );

        // Preserve ang original overvote at undervote rules.
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

    return {
        positions,
        votes
    };
}

/* CANDIDATE BUBBLE ANALYSIS */

function analyzeBubbleCoordinates(image, H, coordinates, paper) {
    if (!Array.isArray(coordinates) || !coordinates.length) {
        throw new Error(
            "No saved bubble coordinates found."
        );
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

        // Measure gamit ang local brightness.
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

        // Uncertain shading ay para sa retake gate.
        const unclear = measurement.unclear === true;

        position.candidates.push({
            candidate_id: candidateId,
            name: coord.candidate_name,
            filled: measurement.selected === true,
            unclear,

            fill_intensity:
                Math.round(measurement.marked * 10000) / 100,

            contrast:
                Math.round(measurement.average * 100) / 100,

            confidence: measurement.confidence,

            local_contrast:
                Math.round(
                    measurement.localContrast * 100
                ) / 100
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

        if (
            counting &&
            process.env.OMR_COUNTING_ENABLED !== "true"
        ) {
            return fail(403, "Live counting is disabled.");
        }

        const electionId = Number(req.body?.election_id);
        const templateId = Number(req.body?.template_id);

        if (
            !req.file?.path ||
            !validId(electionId) ||
            !validId(templateId)
        ) {
            return fail(
                400,
                "Ballot image, election ID and template ID are required."
            );
        }

        // Basahin muna ang original image.
        let originalImage;

        try {
            originalImage = await readOMRImage(req.file.path);
        } catch (error) {
            return fail(
                422,
                "Invalid ballot photo. " + error.message,
                {
                    retake_required: true,
                    quality_issue: "IMAGE"
                }
            );
        }

        const info = {
            width: originalImage.width,
            height: originalImage.height
        };

        // Unang QR attempt sa original photo.
        // Kapag pumalya, susubukan ulit after crop.
        let qr = null;

        try {
            qr = await readBallotQR(req.file.path);
        } catch (error) {
            console.warn(
                "Initial QR detection failed:",
                error.message
            );
        }

        // Hanapin ang registration markers.
        // Subukan ang original at normalized image.
        let marks = null;
        let markerError = null;

        try {
            marks = await findMarkers(
                originalImage,
                info.width,
                info.height
            );
        } catch (error) {
            markerError = error;
        }

        if (!marks) {
            try {
                const normalized = await normalizeOMRLighting(
                    originalImage
                );

                marks = await findMarkers(
                    normalized,
                    normalized.width,
                    normalized.height
                );

                markerError = null;
            } catch (error) {
                markerError = error;
            }
        }

        if (!marks || marks.length !== 4) {
            return fail(
                422,
                "Alignment failed. Retake the photo. " +
                (markerError?.message ||
                    "Four registration markers not detected."),
                {
                    retake_required: true,
                    quality_issue: "ALIGNMENT"
                }
            );
        }

        // I-validate ang marker geometry.
        try {
            validateMarkerQuadrilateral(marks);
        } catch (error) {
            return fail(
                422,
                "Invalid A5 alignment. " + error.message,
                {
                    retake_required: true,
                    quality_issue: "ALIGNMENT"
                }
            );
        }

        // Automatic perspective crop.
        // Original grayscale ang ginagamit para
        // mapanatili ang pencil shading.
        let croppedBallot;

        try {
            croppedBallot = rectifyA5Ballot(
                originalImage,
                marks
            );
        } catch (error) {
            return fail(
                422,
                "Automatic crop failed. " + error.message,
                {
                    retake_required: true,
                    quality_issue: "CROP"
                }
            );
        }

        // Exposure check sa cropped paper, hindi
        // sa background ng original camera photo.
        const exposure = measureImageExposure(
            croppedBallot
        );

        if (
            exposure.dark_ratio > 0.50 ||
            exposure.bright_ratio > 0.80
        ) {
            return fail(
                422,
                "Poor ballot exposure. Retake with even lighting. " +
                "No votes saved.",
                {
                    retake_required: true,
                    quality_issue: "EXPOSURE"
                }
            );
        }

        // Lighting correction pagkatapos ng crop.
        let correctedBallot;

        try {
            correctedBallot = await normalizeOMRLighting(
                croppedBallot
            );
        } catch (error) {
            return fail(
                422,
                "Lighting correction failed. " + error.message,
                {
                    retake_required: true,
                    quality_issue: "LIGHTING"
                }
            );
        }

        // QR fallback gamit ang cropped ballot.
        if (!qr) {
            try {
                qr = await readBallotQR(
                    req.file.path,
                    correctedBallot
                );
            } catch (error) {
                return fail(
                    422,
                    "QR verification failed. " + error.message,
                    {
                        retake_required: true,
                        quality_issue: "QR"
                    }
                );
            }
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

        // Check ballot eligibility.

        db = await pool.getConnection();

        const [ballots] = await db.execute(
            `SELECT status
             FROM issued_ballots
             WHERE ballot_id = ?
               AND election_id = ?
               AND template_id = ?
             LIMIT 1`,
            [
                qr.ballot_id,
                electionId,
                templateId
            ]
        );

        if (!ballots.length) {
            return fail(422, "Unregistered ballot.");
        }

        const ballotStatus = ballots[0].status;

        if (!["ISSUED", "CAST"].includes(ballotStatus)) {
            return fail(
                409,
                "Ballot is not eligible for scanning.",
                {
                    status: ballotStatus,
                    duplicate: ballotStatus === "COUNTED"
                }
            );
        }

        // Kunin ang original template coordinates.
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
            return fail(
                422,
                "Only A5 portrait ballots are supported."
            );
        }

        if (
            !Array.isArray(record.coordinates) ||
            !record.coordinates.length
        ) {
            return fail(
                422,
                "No saved bubble coordinates found."
            );
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

        // Identity homography: corrected image ay
        // nasa template coordinate space na.
        const identityH = [
            1, 0, 0,
            0, 1, 0,
            0, 0
        ];

        let analysis;

        try {
            analysis = analyzeBubbleCoordinates(
                correctedBallot,
                identityH,
                record.coordinates,
                paper
            );
        } catch (error) {
            return fail(
                422,
                "Bubble detection failed. Retake the photo. " +
                error.message,
                {
                    retake_required: true,
                    quality_issue: "BUBBLE_ALIGNMENT"
                }
            );
        }

        const { positions, votes } = analysis;

        // Any uncertain candidate triggers retake,
        // including positions with overvotes.
        const needsReview = positions.filter(
            position =>
                position.result === "NEEDS_REVIEW" ||
                position.unclear === true ||
                position.candidates.some(
                    candidate => candidate.unclear === true
                )
        );

        if (counting && needsReview.length) {
            return fail(
                422,
                "Unclear shading detected. Retake or rescan " +
                "the same ballot. No votes saved.",
                {
                    retake_required: true,
                    quality_issue: "UNCLEAR_SHADING",
                    review_required: true,
                    positions,
                    unclear_positions: needsReview.map(
                        position => position.position_name
                    )
                }
            );
        }

        // DATABASE TRANSACTION

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

        // Gumawa ng corrected A5 preview para sa scanner UI.
        // Hindi dapat maapektuhan ang committed votes
        // kapag pumalya ang preview encoding.
        let correctedPreview = null;

        try {
            const previewWidth = Math.min(
                900,
                correctedBallot.width
            );

            const previewBuffer = await sharp(
                correctedBallot.data,
                {
                    raw: {
                        width: correctedBallot.width,
                        height: correctedBallot.height,
                        channels: 1
                    }
                }
            )
                .resize({
                    width: previewWidth,
                    withoutEnlargement: true
                })
                .jpeg({
                    quality: 72,
                    mozjpeg: true
                })
                .toBuffer();

            // Limitahan ang payload para sa mobile.
            if (previewBuffer.length <= 350 * 1024) {
                correctedPreview = {
                    mime_type: "image/jpeg",
                    base64: previewBuffer.toString("base64"),
                    width: previewWidth,
                    height: Math.round(
                        correctedBallot.height *
                        previewWidth / correctedBallot.width
                    )
                };
            }
        } catch (previewError) {
            console.error(
                "OMR corrected preview unavailable:",
                previewError.message
            );
        }

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

            // Ito ang babasahin ng scanner.js
            // para ipakita ang aligned A5 ballot.
            corrected_preview: correctedPreview,

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

        // Kunin ang confirmed votes ng bawat candidate.
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

        // Live tallies lang ang ibalik.
        // Corrected preview ay nasa uploadAndProcess().
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
