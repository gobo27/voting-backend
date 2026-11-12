"use strict";

const sharp = require("sharp");
const { Worker } = require("node:worker_threads");
const { analyzeBubbles } = require("./omr_opencv");
const fs = require("fs/promises");
const { performance } = require("perf_hooks");
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

const mm = value => value * DPI / 25.4;

function validId(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0;
}

function parseQR(qrData) {
    const parts = String(qrData || "").trim().split("|");

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

/* CONSERVATIVE PAPER CROP */

function histogramPercentile(histogram, count, fraction) {
    const target = Math.ceil(count * fraction);
    let sum = 0;

    for (let value = 0; value < 256; value++) {
        sum += histogram[value];
        if (sum >= target) return value;
    }

    return 255;
}

function findPaperCrop(data, width, height) {
    const histogram = new Uint32Array(256);

    for (const value of data) {
        histogram[value]++;
    }

    const low = histogramPercentile(
        histogram, data.length, 0.10
    );

    const high = histogramPercentile(
        histogram, data.length, 0.90
    );

    if (high - low < 40) {
        return { reason: "low_background_contrast" };
    }

    // A low split retains shadowed paper edges.
    const threshold = low + (high - low) * 0.24;

    const seen = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    const components = [];

    for (let start = 0; start < data.length; start++) {
        if (seen[start] || data[start] < threshold) {
            continue;
        }

        let head = 0;
        let tail = 1;

        queue[0] = start;
        seen[start] = 1;

        let left = width;
        let right = -1;
        let top = height;
        let bottom = -1;

        while (head < tail) {
            const index = queue[head++];
            const y = Math.floor(index / width);
            const x = index - y * width;

            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);

            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= height) continue;

                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx;

                    if (
                        (!dx && !dy) ||
                        xx < 0 ||
                        xx >= width
                    ) {
                        continue;
                    }

                    const next = yy * width + xx;

                    if (
                        !seen[next] &&
                        data[next] >= threshold
                    ) {
                        seen[next] = 1;
                        queue[tail++] = next;
                    }
                }
            }
        }

        if (tail >= data.length * 0.04) {
            components.push({
                area: tail,
                left,
                right,
                top,
                bottom
            });
        }
    }

    components.sort((a, b) => b.area - a.area);

    if (!components.length) {
        return { reason: "no_dominant_paper" };
    }

    const main = components[0];

    if (
        components.slice(1).some(
            component => component.area >= main.area * 0.20
        )
    ) {
        return { reason: "multiple_light_regions" };
    }

    const boxWidth = main.right - main.left + 1;
    const boxHeight = main.bottom - main.top + 1;
    const fill = main.area / (boxWidth * boxHeight);

    if (
        main.area < data.length * 0.16 ||
        fill < 0.50 ||
        boxWidth < width * 0.20 ||
        boxHeight < height * 0.20
    ) {
        return { reason: "uncertain_paper_boundary" };
    }

    const padding = Math.max(
        8,
        Math.ceil(Math.min(boxWidth, boxHeight) * 0.05)
    );

    const left = Math.max(0, main.left - padding);
    const top = Math.max(0, main.top - padding);

    const right = Math.min(
        width,
        main.right + 1 + padding
    );

    const bottom = Math.min(
        height,
        main.bottom + 1 + padding
    );

    if (
        (right - left) * (bottom - top) >
        width * height * 0.94
    ) {
        return { reason: "paper_already_fills_frame" };
    }

    return {
        crop: {
            left,
            top,
            width: right - left,
            height: bottom - top
        },
        reason: "single_dominant_light_region"
    };
}

function extractGray(image, crop) {
    const data = Buffer.allocUnsafe(
        crop.width * crop.height
    );

    for (let row = 0; row < crop.height; row++) {
        const start =
            (crop.top + row) * image.width + crop.left;

        image.data.copy(
            data,
            row * crop.width,
            start,
            start + crop.width
        );
    }

    return {
        data,
        width: crop.width,
        height: crop.height,
        channels: 1
    };
}

async function resizeGray(image, maxSide) {
    const ratio = Math.min(
        1,
        maxSide / Math.max(image.width, image.height)
    );

    const width = Math.max(
        1,
        Math.round(image.width * ratio)
    );

    const height = Math.max(
        1,
        Math.round(image.height * ratio)
    );

    if (
        width === image.width &&
        height === image.height
    ) {
        return {
            data: image.data,
            width,
            height,
            channels: 1
        };
    }

    const { data, info } = await sharp(
        image.data,
        {
            raw: {
                width: image.width,
                height: image.height,
                channels: 1
            }
        }
    )
        .resize(width, height, { fit: "fill" })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    return {
        data,
        width: info.width,
        height: info.height,
        channels: 1
    };
}

async function prepareBallotImage(imagePath, options = {}) {
    const started = performance.now();
    const maxSide = options.maxSide ?? 2600;
    const detectionMaxSide = options.detectionMaxSide ?? 1100;

    if (
        ![maxSide, detectionMaxSide].every(
            number =>
                Number.isSafeInteger(number) &&
                number >= 200
        )
    ) {
        throw new Error(
            "Invalid ballot preprocessing resolution."
        );
    }

    const metadata = await sharp(imagePath).metadata();

    const swap =
        metadata.orientation >= 5 &&
        metadata.orientation <= 8;

    const sourceWidth =
        metadata.autoOrient?.width ||
        (swap ? metadata.height : metadata.width);

    const sourceHeight =
        metadata.autoOrient?.height ||
        (swap ? metadata.width : metadata.height);

    if (!sourceWidth || !sourceHeight) {
        throw new Error(
            "Invalid ballot image dimensions."
        );
    }

    // Decode once. Marker and bubble processing share this coordinate frame.
    const decoded = await sharp(imagePath)
        .rotate()
        .flatten({ background: "#ffffff" })
        .resize({
            width: maxSide,
            height: maxSide,
            fit: "inside",
            withoutEnlargement: true
        })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    let image = {
        data: decoded.data,
        width: decoded.info.width,
        height: decoded.info.height,
        channels: 1
    };

    const uncroppedWidth = image.width;
    const uncroppedHeight = image.height;

    const analysis = await resizeGray(
        image,
        Math.min(700, detectionMaxSide)
    );

    const paper = options.autoCrop === false
        ? { reason: "disabled" }
        : findPaperCrop(
            analysis.data,
            analysis.width,
            analysis.height
        );

    let crop = {
        left: 0,
        top: 0,
        width: image.width,
        height: image.height
    };

    if (paper.crop) {
        const scaleX = image.width / analysis.width;
        const scaleY = image.height / analysis.height;

        const left = Math.max(
            0,
            Math.floor(paper.crop.left * scaleX)
        );

        const top = Math.max(
            0,
            Math.floor(paper.crop.top * scaleY)
        );

        const right = Math.min(
            image.width,
            Math.ceil(
                (paper.crop.left + paper.crop.width) * scaleX
            )
        );

        const bottom = Math.min(
            image.height,
            Math.ceil(
                (paper.crop.top + paper.crop.height) * scaleY
            )
        );

        crop = {
            left,
            top,
            width: right - left,
            height: bottom - top
        };

        image = extractGray(image, crop);
    }

    const sourceScaleX = sourceWidth / uncroppedWidth;
    const sourceScaleY = sourceHeight / uncroppedHeight;

    return {
        image,
        preprocessing: {
            source_width: sourceWidth,
            source_height: sourceHeight,
            uncropped_width: uncroppedWidth,
            uncropped_height: uncroppedHeight,
            working_width: image.width,
            working_height: image.height,
            auto_crop_applied: Boolean(paper.crop),
            auto_crop_reason: paper.reason,
            crop,
            source_crop: {
                left: crop.left * sourceScaleX,
                top: crop.top * sourceScaleY,
                width: crop.width * sourceScaleX,
                height: crop.height * sourceScaleY
            },
            auto_lighting_applied: true,
            lighting_scope: "dynamic_markers_and_opencv_bubbles",
            preprocess_ms: Math.round(
                performance.now() - started
            )
        }
    };
}

/* ORIENTATION FROM QR */

function rotatePoint(point, width, height, degrees) {
    if (degrees === 90) {
        return {
            x: height - 1 - point.y,
            y: point.x
        };
    }

    if (degrees === 180) {
        return {
            x: width - 1 - point.x,
            y: height - 1 - point.y
        };
    }

    if (degrees === 270) {
        return {
            x: point.y,
            y: width - 1 - point.x
        };
    }

    return { x: point.x, y: point.y };
}

function rotateGray(image, degrees) {
    if (!degrees) return image;

    const width = degrees === 180
        ? image.width
        : image.height;

    const height = degrees === 180
        ? image.height
        : image.width;

    const data = Buffer.allocUnsafe(width * height);

    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const point = rotatePoint(
                { x, y },
                image.width,
                image.height,
                degrees
            );

            data[point.y * width + point.x] =
                image.data[y * image.width + x];
        }
    }

    return {
        ...image,
        data,
        width,
        height,
        channels: 1
    };
}

function orientPreparedBallot(prepared, location) {
    const left = location?.topLeftCorner;
    const right = location?.topRightCorner;

    if (
        !left ||
        !right ||
        ![left.x, left.y, right.x, right.y].every(Number.isFinite)
    ) {
        throw new Error(
            "QR orientation could not be established. Retake one clear ballot photo."
        );
    }

    const angle =
        Math.atan2(
            right.y - left.y,
            right.x - left.x
        ) * 180 / Math.PI;

    const degrees =
        ((-Math.round(angle / 90) * 90) % 360 + 360) % 360;

    const oldWidth = prepared.image.width;
    const oldHeight = prepared.image.height;

    const image = rotateGray(
        prepared.image,
        degrees
    );

    const qrLocation = {};

    for (const [key, point] of Object.entries(location)) {
        qrLocation[key] =
            point &&
                Number.isFinite(point.x) &&
                Number.isFinite(point.y)
                ? rotatePoint(
                    point,
                    oldWidth,
                    oldHeight,
                    degrees
                )
                : point;
    }

    return {
        ...prepared,
        image,
        qrLocation,
        preprocessing: {
            ...prepared.preprocessing,
            orientation_rotation_degrees: degrees,
            working_width: image.width,
            working_height: image.height
        }
    };
}

/* QR DECODING IN A BOUNDED WORKER */

function qrWorkerTask() {
    const {
        parentPort,
        workerData
    } = require("node:worker_threads");

    const { performance } = require("node:perf_hooks");

    const qrError = (
        code,
        message,
        httpStatus = 422
    ) => Object.assign(
        new Error(message),
        { code, httpStatus }
    );

    try {
        const jsQR = require(workerData.modulePath);
        const { image, deadline } = workerData;

        const started = performance.now();
        let attempts = 0;

        const regions = [
            {
                name: "upper-right",
                x: 0.46, y: 0, w: 0.54, h: 0.50,
                side: 1100
            },
            {
                name: "lower-left",
                x: 0, y: 0.50, w: 0.54, h: 0.50,
                side: 1100
            },
            {
                name: "upper-half",
                x: 0, y: 0, w: 1, h: 0.55,
                side: 1400
            },
            {
                name: "full",
                x: 0, y: 0, w: 1, h: 1,
                side: 1800
            }
        ];

        function regionPixels(region, enhanced) {
            const left = Math.floor(
                region.x * image.width
            );

            const top = Math.floor(
                region.y * image.height
            );

            const sourceWidth = Math.min(
                image.width - left,
                Math.round(region.w * image.width)
            );

            const sourceHeight = Math.min(
                image.height - top,
                Math.round(region.h * image.height)
            );

            const scale = Math.min(
                1,
                region.side / Math.max(
                    sourceWidth,
                    sourceHeight
                )
            );

            const width = Math.max(
                1,
                Math.round(sourceWidth * scale)
            );

            const height = Math.max(
                1,
                Math.round(sourceHeight * scale)
            );

            const rgba = new Uint8ClampedArray(
                width * height * 4
            );

            const histogram = enhanced
                ? new Uint32Array(256)
                : null;

            for (let y = 0; y < height; y++) {
                const sourceY = Math.min(
                    image.height - 1,
                    top + Math.floor(
                        (y + 0.5) * sourceHeight / height
                    )
                );

                for (let x = 0; x < width; x++) {
                    const sourceX = Math.min(
                        image.width - 1,
                        left + Math.floor(
                            (x + 0.5) * sourceWidth / width
                        )
                    );

                    const inputIndex =
                        (sourceY * image.width + sourceX) *
                        image.channels;

                    const value = image.channels === 1
                        ? image.data[inputIndex]
                        : Math.round(
                            image.data[inputIndex] * 0.299 +
                            image.data[inputIndex + 1] * 0.587 +
                            image.data[inputIndex + 2] * 0.114
                        );

                    const outputIndex =
                        (y * width + x) * 4;

                    rgba[outputIndex] = value;
                    rgba[outputIndex + 1] = value;
                    rgba[outputIndex + 2] = value;
                    rgba[outputIndex + 3] = 255;

                    if (histogram) {
                        histogram[value]++;
                    }
                }
            }

            if (histogram) {
                const count = width * height;

                let cumulative = 0;
                let low = 0;
                let high = 255;
                let foundLow = false;

                for (let value = 0; value < 256; value++) {
                    cumulative += histogram[value];

                    if (
                        !foundLow &&
                        cumulative >= count * 0.02
                    ) {
                        low = value;
                        foundLow = true;
                    }

                    if (cumulative >= count * 0.98) {
                        high = value;
                        break;
                    }
                }

                if (high > low + 8) {
                    const gain = 255 / (high - low);

                    for (
                        let index = 0;
                        index < rgba.length;
                        index += 4
                    ) {
                        const value = Math.max(
                            0,
                            Math.min(
                                255,
                                Math.round(
                                    (rgba[index] - low) * gain
                                )
                            )
                        );

                        rgba[index] = value;
                        rgba[index + 1] = value;
                        rgba[index + 2] = value;
                    }
                }
            }

            return {
                rgba,
                width,
                height,
                left,
                top,
                sourceWidth,
                sourceHeight
            };
        }

        let found = null;

        for (const enhanced of [false, true]) {
            for (const region of regions) {
                if (Date.now() >= deadline) {
                    throw qrError(
                        "OMR_QR_TIMEOUT",
                        "QR scan timed out. Retake a clear photo of one A5 ballot."
                    );
                }

                const crop = regionPixels(
                    region,
                    enhanced
                );

                const result = jsQR(
                    crop.rgba,
                    crop.width,
                    crop.height,
                    {
                        inversionAttempts: enhanced
                            ? "attemptBoth"
                            : "dontInvert"
                    }
                );

                attempts++;

                if (!result?.data) continue;

                const location = {};

                for (
                    const [key, point] of
                    Object.entries(result.location || {})
                ) {
                    if (
                        point &&
                        Number.isFinite(point.x) &&
                        Number.isFinite(point.y)
                    ) {
                        location[key] = {
                            x:
                                crop.left +
                                (point.x + 0.5) *
                                crop.sourceWidth / crop.width -
                                0.5,

                            y:
                                crop.top +
                                (point.y + 0.5) *
                                crop.sourceHeight / crop.height -
                                0.5
                        };
                    }
                }

                found = {
                    data: result.data,
                    location,
                    region: region.name,
                    enhanced,
                    attempts,
                    workerMs: Math.round(
                        performance.now() - started
                    ),
                    imageWidth: image.width,
                    imageHeight: image.height
                };

                break;
            }

            if (found) break;
        }

        if (!found) {
            throw qrError(
                "OMR_QR_NOT_FOUND",
                "QR code not detected. Retake a clear photo of one A5 ballot. No votes recorded."
            );
        }

        parentPort.postMessage({ result: found });
    } catch (error) {
        parentPort.postMessage({
            error: {
                code: error.code || "OMR_QR_WORKER_FAILED",
                message: error.message || "QR decoding failed.",
                httpStatus: error.httpStatus || 503
            }
        });
    } finally {
        parentPort.close();
    }
}

let activeQRWorkers = 0;

async function readImageQR(image, options = {}) {
    if (activeQRWorkers >= 2) {
        throw Object.assign(
            new Error(
                "The scanner is busy. Retry this ballot."
            ),
            { httpStatus: 503 }
        );
    }

    activeQRWorkers++;

    try {
        return await new Promise((resolve, reject) => {
            const started = performance.now();

            const timeoutMs = Math.max(
                1,
                Math.min(
                    10000,
                    Number(options.timeoutMs) || 6000
                )
            );

            const deadline = Date.now() + timeoutMs;

            let worker;
            let settled = false;

            const finish = (error, result) => {
                if (settled) return;
                settled = true;

                clearTimeout(timer);

                if (worker) {
                    worker.terminate();
                }

                if (error) reject(error);
                else resolve(result);
            };

            const timer = setTimeout(() => {
                finish(
                    Object.assign(
                        new Error(
                            "QR scanning timed out. Retake a clearer photo."
                        ),
                        { httpStatus: 422 }
                    )
                );
            }, timeoutMs);

            try {
                const copy = Uint8Array.from(image.data);

                worker = new Worker(
                    `(${qrWorkerTask.toString()})();`,
                    {
                        eval: true,
                        workerData: {
                            task: "omr-qr",
                            deadline,
                            modulePath: require.resolve("jsqr"),
                            image: {
                                data: copy,
                                width: image.width,
                                height: image.height,
                                channels: 1
                            }
                        },
                        transferList: [copy.buffer]
                    }
                );

                worker.once("message", message => {
                    if (Date.now() >= deadline) {
                        finish(
                            Object.assign(
                                new Error(
                                    "QR scanning timed out. Retake a clearer photo."
                                ),
                                { httpStatus: 422 }
                            )
                        );
                    } else if (message.error) {
                        finish(
                            Object.assign(
                                new Error(message.error.message),
                                {
                                    httpStatus:
                                        message.error.httpStatus || 422
                                }
                            )
                        );
                    } else {
                        finish(null, {
                            ...message.result,
                            elapsedMs: Math.round(
                                performance.now() - started
                            )
                        });
                    }
                });

                worker.once("error", () => {
                    finish(
                        Object.assign(
                            new Error(
                                "QR decoder unavailable. Check backend dependencies."
                            ),
                            { httpStatus: 503 }
                        )
                    );
                });

                worker.once("exit", () => {
                    if (!settled) {
                        finish(
                            Object.assign(
                                new Error(
                                    "QR decoder stopped before completion."
                                ),
                                { httpStatus: 503 }
                            )
                        );
                    }
                });
            } catch (_) {
                finish(
                    Object.assign(
                        new Error(
                            "QR decoder unavailable. Install jsqr in the backend."
                        ),
                        { httpStatus: 503 }
                    )
                );
            }
        });
    } finally {
        activeQRWorkers--;
    }
}

/*
 * ALIGNMENT CHANGE:
 * Slightly increased tolerances, shared by marker selection
 * and the final homography-frame validation.
 */
const ALIGNMENT_LIMITS = Object.freeze({
    ratioError: 0.24,
    widthError: 0.40,
    heightError: 0.40,
    sizeError: 0.55,
    markerAspectMin: 2 / 3,
    markerAspectMax: 1.50
});

/* DYNAMIC MARKER THRESHOLD */

function markerOtsuThreshold(histogram, total) {
    let totalSum = 0;

    for (let value = 0; value < 256; value++) {
        totalSum += value * histogram[value];
    }

    let lowerCount = 0;
    let lowerSum = 0;
    let bestScore = -1;
    let threshold = 0;

    for (let value = 0; value < 255; value++) {
        lowerCount += histogram[value];
        lowerSum += value * histogram[value];

        const upperCount = total - lowerCount;

        if (!lowerCount || !upperCount) continue;

        const lowerMean = lowerSum / lowerCount;
        const upperMean =
            (totalSum - lowerSum) / upperCount;

        const difference = lowerMean - upperMean;

        const score =
            lowerCount *
            upperCount *
            difference *
            difference;

        if (score > bestScore) {
            bestScore = score;
            threshold = value;
        }
    }

    return {
        threshold,
        separable: bestScore >= 0
    };
}

/*
 * SHADOW CHANGE:
 * Estimate local bright paper in tiles, normalize illumination,
 * then derive the marker threshold from the normalized histogram.
 *
 * No fixed original-pixel threshold is used.
 */
function markerLightingMask(data, width, height) {
    const cell = Math.max(
        24,
        Math.min(
            64,
            Math.round(Math.max(width, height) * 0.035)
        )
    );

    const columns = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);

    const paper = new Uint8Array(columns * rows);
    const histogram = new Uint32Array(256);

    for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < columns; tx++) {
            histogram.fill(0);

            const x0 = tx * cell;
            const y0 = ty * cell;
            const x1 = Math.min(width, x0 + cell);
            const y1 = Math.min(height, y0 + cell);

            for (let y = y0; y < y1; y++) {
                const offset = y * width;

                for (let x = x0; x < x1; x++) {
                    histogram[data[offset + x]]++;
                }
            }

            const target = Math.ceil(
                (x1 - x0) * (y1 - y0) * 0.85
            );

            let count = 0;
            let value = 0;

            for (; value < 255; value++) {
                count += histogram[value];
                if (count >= target) break;
            }

            paper[ty * columns + tx] = value;
        }
    }

    const normalized = new Uint8Array(data.length);

    histogram.fill(0);

    for (let y = 0; y < height; y++) {
        const gy = y / cell - 0.5;

        const y0 = Math.max(
            0,
            Math.min(rows - 1, Math.floor(gy))
        );

        const y1 = Math.max(
            0,
            Math.min(rows - 1, Math.floor(gy) + 1)
        );

        for (let x = 0; x < width; x++) {
            const gx = x / cell - 0.5;

            const x0 = Math.max(
                0,
                Math.min(columns - 1, Math.floor(gx))
            );

            const x1 = Math.max(
                0,
                Math.min(columns - 1, Math.floor(gx) + 1)
            );

            /*
             * Use the lower local paper reference so a bright tile
             * is not blended across a hard shadow edge.
             */
            const baseline = Math.max(
                12,
                Math.min(
                    paper[y0 * columns + x0],
                    paper[y0 * columns + x1],
                    paper[y1 * columns + x0],
                    paper[y1 * columns + x1]
                )
            );

            const index = y * width + x;

            const value = Math.min(
                255,
                Math.round(data[index] * 255 / baseline)
            );

            normalized[index] = value;
            histogram[value]++;
        }
    }

    const otsu = markerOtsuThreshold(
        histogram,
        normalized.length
    );

    const mask = new Uint8Array(data.length);

    if (otsu.separable) {
        for (let i = 0; i < mask.length; i++) {
            mask[i] =
                normalized[i] <= otsu.threshold ? 1 : 0;
        }
    }

    return {
        mask,
        threshold: otsu.threshold,
        model: "local_bright_paper_otsu",
        background_cell_px: cell
    };
}

async function findMarkers(image) {
    const input = image && (
        image.data || image.graydata
    );

    if (
        !image ||
        !input ||
        !Number.isInteger(image.width) ||
        !Number.isInteger(image.height) ||
        image.width < 32 ||
        image.height < 32 ||
        input.length !== image.width * image.height
    ) {
        throw markerAlignmentError(
            "Invalid grayscale image for marker detection.",
            {}
        );
    }

    const scale = Math.min(
        1,
        1100 / Math.max(image.width, image.height)
    );

    const width = Math.max(
        1,
        Math.round(image.width * scale)
    );

    const height = Math.max(
        1,
        Math.round(image.height * scale)
    );

    const decoded = await sharp(input, {
        raw: {
            width: image.width,
            height: image.height,
            channels: 1
        }
    })
        .resize(width, height, { fit: "fill" })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    if (
        decoded.info.channels !== 1 ||
        decoded.data.length !== width * height
    ) {
        throw markerAlignmentError(
            "Marker preprocessing must produce one grayscale channel.",
            {}
        );
    }

    const dynamic = markerLightingMask(
        decoded.data,
        width,
        height
    );

    return detectMarkerSquares(
        {
            data: decoded.data,
            width,
            height,
            mask: dynamic.mask,
            threshold: dynamic.threshold,
            thresholdModel: dynamic.model,
            backgroundCell: dynamic.background_cell_px
        },
        image
    );
}

/* REGISTRATION SQUARE SHAPE AND GEOMETRY */

const MARKER_EXPECTED_RATIO = 129 / 193;
const MARKER_MAX_CANDIDATES = 12;

function markerAlignmentError(message, diagnostics) {
    const error = new Error(message);

    error.code = "OMR_ALIGNMENT";
    error.httpStatus = 422;
    error.diagnostics = diagnostics;

    return error;
}

/*
 * ALIGNMENT CHANGE:
 * Fit oriented boxes so tilted solid squares retain their density.
 */
function markerSquareFit(pixels, width) {
    let best = null;

    for (
        let degrees = 0;
        degrees < 90;
        degrees += 3
    ) {
        const angle = degrees * Math.PI / 180;

        const c = Math.cos(angle);
        const s = Math.sin(angle);

        let minU = Infinity;
        let maxU = -Infinity;
        let minV = Infinity;
        let maxV = -Infinity;

        for (let i = 0; i < pixels.length; i++) {
            const y = Math.floor(pixels[i] / width);
            const x = pixels[i] - y * width;

            const u = x * c + y * s;
            const v = -x * s + y * c;

            if (u < minU) minU = u;
            if (u > maxU) maxU = u;
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
        }

        const support =
            Math.abs(c) + Math.abs(s);

        const boxWidth =
            maxU - minU + support;

        const boxHeight =
            maxV - minV + support;

        const boxArea = boxWidth * boxHeight;

        if (!best || boxArea < best.area) {
            best = {
                width: boxWidth,
                height: boxHeight,
                area: boxArea,
                degrees,
                minU: minU - support / 2,
                minV: minV - support / 2
            };
        }
    }

    return best;
}

function markerCornerCoverage(pixels, width, box) {
    const angle = box.degrees * Math.PI / 180;

    const c = Math.cos(angle);
    const s = Math.sin(angle);

    const counts = [0, 0, 0, 0];

    for (const n of pixels) {
        const y = Math.floor(n / width);
        const x = n - y * width;

        const u =
            (x * c + y * s - box.minU) / box.width;

        const v =
            (-x * s + y * c - box.minV) / box.height;

        if (u < 0.25 && v < 0.25) counts[0]++;
        if (u > 0.75 && v < 0.25) counts[1]++;
        if (u < 0.25 && v > 0.75) counts[2]++;
        if (u > 0.75 && v > 0.75) counts[3]++;
    }

    return (
        counts.reduce((sum, value) => sum + value, 0) *
        4 / pixels.length
    );
}

function markerConvex(tl, tr, bl, br) {
    const polygon = [tl, tr, br, bl];

    for (let i = 0; i < 4; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % 4];
        const c = polygon[(i + 2) % 4];

        const cross =
            (b.x - a.x) * (c.y - b.y) -
            (b.y - a.y) * (c.x - b.x);

        if (cross <= 0) return false;
    }

    return true;
}

function markerQrPolygon(location, scaleX, scaleY) {
    if (!location) return null;

    const points = [
        location.topLeftCorner,
        location.topRightCorner,
        location.bottomRightCorner,
        location.bottomLeftCorner
    ];

    if (
        points.some(point =>
            !point ||
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y)
        )
    ) {
        return null;
    }

    return points.map(point => ({
        x: point.x * scaleX,
        y: point.y * scaleY
    }));
}

function markerInsidePolygon(x, y, polygon) {
    let sign = 0;

    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];

        const cross =
            (b.x - a.x) * (y - a.y) -
            (b.y - a.y) * (x - a.x);

        if (cross === 0) continue;

        const currentSign = Math.sign(cross);

        if (sign && sign !== currentSign) {
            return false;
        }

        sign = currentSign;
    }

    return true;
}

function detectMarkerSquares(
    detectionImage,
    workingImage,
    options = {}
) {
    const started = performance.now();

    const {
        data,
        width: w,
        height: h
    } = detectionImage || {};

    if (
        !Number.isInteger(w) ||
        !Number.isInteger(h) ||
        w < 32 ||
        h < 32 ||
        !data ||
        data.length !== w * h ||
        !workingImage ||
        !Number.isInteger(workingImage.width) ||
        workingImage.width < 1 ||
        !Number.isInteger(workingImage.height) ||
        workingImage.height < 1
    ) {
        throw markerAlignmentError(
            "Invalid grayscale image for registration marker detection.",
            {}
        );
    }

    const scaleX = w / workingImage.width;
    const scaleY = h / workingImage.height;

    const qr = markerQrPolygon(
        options.qrLocation,
        scaleX,
        scaleY
    );

    const mask = detectionImage.mask;
    const seen = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);

    const threshold = detectionImage.threshold;

    const maxX = Math.max(
        1,
        Math.round(w * 0.40)
    );

    const maxY = Math.max(
        1,
        Math.round(h * 0.40)
    );

    const corners = [
        { x: 0, y: 0 },
        { x: w - 1, y: 0 },
        { x: 0, y: h - 1 },
        { x: w - 1, y: h - 1 }
    ];

    const candidates = [];
    const componentCounts = [];

    for (
        let cornerIndex = 0;
        cornerIndex < 4;
        cornerIndex++
    ) {
        const x0 = cornerIndex % 2 === 0
            ? 0
            : w - maxX;

        const x1 = cornerIndex % 2 === 0
            ? maxX
            : w;

        const y0 = cornerIndex < 2
            ? 0
            : h - maxY;

        const y1 = cornerIndex < 2
            ? maxY
            : h;

        const cheapCandidates = [];
        let componentCount = 0;

        for (let yy = y0; yy < y1; yy++) {
            for (let xx = x0; xx < x1; xx++) {
                const start = yy * w + xx;

                if (!mask[start] || seen[start]) continue;

                componentCount++;

                let head = 0;
                let tail = 1;

                queue[0] = start;
                seen[start] = 1;

                let sx = 0;
                let sy = 0;
                let sxx = 0;
                let syy = 0;
                let sxy = 0;

                let left = xx;
                let right = xx;
                let top = yy;
                let bottom = yy;

                let touchesBoundary = false;

                while (head < tail) {
                    const n = queue[head++];

                    const py = Math.floor(n / w);
                    const px = n - py * w;

                    sx += px;
                    sy += py;
                    sxx += px * px;
                    syy += py * py;
                    sxy += px * py;

                    if (px < left) left = px;
                    if (px > right) right = px;
                    if (py < top) top = py;
                    if (py > bottom) bottom = py;

                    if (
                        px === x0 ||
                        px === x1 - 1 ||
                        py === y0 ||
                        py === y1 - 1
                    ) {
                        touchesBoundary = true;
                    }

                    let q;

                    if (px > x0) {
                        q = n - 1;

                        if (mask[q] && !seen[q]) {
                            seen[q] = 1;
                            queue[tail++] = q;
                        }
                    }

                    if (px + 1 < x1) {
                        q = n + 1;

                        if (mask[q] && !seen[q]) {
                            seen[q] = 1;
                            queue[tail++] = q;
                        }
                    }

                    if (py > y0) {
                        q = n - w;

                        if (mask[q] && !seen[q]) {
                            seen[q] = 1;
                            queue[tail++] = q;
                        }
                    }

                    if (py + 1 < y1) {
                        q = n + w;

                        if (mask[q] && !seen[q]) {
                            seen[q] = 1;
                            queue[tail++] = q;
                        }
                    }
                }

                const area = tail;

                const bw = right - left + 1;
                const bh = bottom - top + 1;

                const span = Math.max(bw, bh);

                if (
                    touchesBoundary ||
                    area < 12 ||
                    span < 4 ||
                    span > Math.min(w, h) * 0.078 ||
                    bw / bh < 0.50 ||
                    bw / bh > 2 ||
                    area / (bw * bh) < 0.43
                ) {
                    continue;
                }

                const x = sx / area;
                const y = sy / area;

                if (
                    qr &&
                    markerInsidePolygon(x, y, qr)
                ) {
                    continue;
                }

                const vx =
                    sxx / area - x * x + 1 / 12;

                const vy =
                    syy / area - y * y + 1 / 12;

                const covariance =
                    sxy / area - x * y;

                const det =
                    vx * vy - covariance * covariance;

                if (det <= 0) continue;

                const momentFill =
                    area / (12 * Math.sqrt(det));

                if (
                    momentFill < 0.76 ||
                    momentFill > 1.20
                ) {
                    continue;
                }

                cheapCandidates.push({
                    x,
                    y,
                    area,
                    distance: Math.hypot(
                        x - corners[cornerIndex].x,
                        y - corners[cornerIndex].y
                    ),
                    pixels: Int32Array.from(
                        queue.subarray(0, tail)
                    )
                });
            }
        }

        cheapCandidates.sort(
            (a, b) => a.distance - b.distance
        );

        const list = [];

        for (
            const candidate of
            cheapCandidates.slice(0, 48)
        ) {
            const box = markerSquareFit(
                candidate.pixels,
                w
            );

            const ratio = box.width / box.height;
            const density = candidate.area / box.area;
            const side = (box.width + box.height) / 2;

            if (
                side < 4 ||
                side > Math.min(w, h) * 0.055 ||
                ratio < ALIGNMENT_LIMITS.markerAspectMin ||
                ratio > ALIGNMENT_LIMITS.markerAspectMax ||
                density < 0.78 ||
                markerCornerCoverage(
                    candidate.pixels,
                    w,
                    box
                ) < 0.55
            ) {
                continue;
            }

            list.push({
                x: candidate.x,
                y: candidate.y,
                side,
                density,
                distance: candidate.distance,
                rotation: box.degrees
            });

            if (
                list.length === MARKER_MAX_CANDIDATES
            ) {
                break;
            }
        }

        candidates.push(list);
        componentCounts.push(componentCount);
    }

    const diagnostics = {
        detection_width: w,
        detection_height: h,
        threshold,
        threshold_model: detectionImage.thresholdModel,
        background_cell_px: detectionImage.backgroundCell,
        candidate_counts: candidates.map(list => list.length),
        component_counts: componentCounts,
        geometry_candidates_checked: 0
    };

    if (candidates.some(list => !list.length)) {
        throw markerAlignmentError(
            "Four registration squares were not detected. Keep one complete A5 ballot and all four black squares visible.",
            diagnostics
        );
    }

    let best = null;

    for (const tl of candidates[0]) {
        for (const tr of candidates[1]) {
            const top = Math.hypot(
                tr.x - tl.x,
                tr.y - tl.y
            );

            if (top < w * 0.40) continue;

            for (const bl of candidates[2]) {
                const left = Math.hypot(
                    bl.x - tl.x,
                    bl.y - tl.y
                );

                if (left < h * 0.40) continue;

                for (const br of candidates[3]) {
                    diagnostics.geometry_candidates_checked++;

                    const bottom = Math.hypot(
                        br.x - bl.x,
                        br.y - bl.y
                    );

                    const right = Math.hypot(
                        br.x - tr.x,
                        br.y - tr.y
                    );

                    if (
                        bottom < w * 0.40 ||
                        right < h * 0.40 ||
                        !markerConvex(tl, tr, bl, br)
                    ) {
                        continue;
                    }

                    const measuredRatio =
                        ((top + bottom) / 2) /
                        ((left + right) / 2);

                    const ratioError = Math.abs(
                        measuredRatio - MARKER_EXPECTED_RATIO
                    );

                    const widthError =
                        Math.abs(top - bottom) /
                        Math.max(top, bottom);

                    const heightError =
                        Math.abs(left - right) /
                        Math.max(left, right);

                    const sizes = [
                        tl.side,
                        tr.side,
                        bl.side,
                        br.side
                    ];

                    const sizeError =
                        (
                            Math.max(...sizes) -
                            Math.min(...sizes)
                        ) / Math.max(...sizes);

                    if (
                        ratioError > ALIGNMENT_LIMITS.ratioError ||
                        widthError > ALIGNMENT_LIMITS.widthError ||
                        heightError > ALIGNMENT_LIMITS.heightError ||
                        sizeError > ALIGNMENT_LIMITS.sizeError
                    ) {
                        continue;
                    }

                    // Physical 3 mm squares with 129 x 193 mm center spacing.
                    const expectedSide = 3 * Math.sqrt(
                        ((top + bottom) / (2 * 129)) *
                        ((left + right) / (2 * 193))
                    );

                    if (
                        sizes.some(side =>
                            side < expectedSide * 0.50 ||
                            side > expectedSide * 1.85
                        )
                    ) {
                        continue;
                    }

                    const sizeRatioError =
                        sizes.reduce(
                            (sum, side) =>
                                sum + Math.abs(
                                    Math.log(side / expectedSide)
                                ),
                            0
                        ) / 4;

                    const score =
                        ratioError * 5 +
                        widthError * 2 +
                        heightError * 2 +
                        sizeError * 1.5 +
                        sizeRatioError +
                        (
                            tl.distance +
                            tr.distance +
                            bl.distance +
                            br.distance
                        ) / (w + h);

                    if (!best || score < best.score) {
                        best = {
                            score,
                            marks: [tl, tr, bl, br]
                        };
                    }
                }
            }
        }
    }

    if (!best) {
        throw markerAlignmentError(
            "Registration squares do not match one A5 portrait ballot. Move closer, keep the page flat, and keep all four squares unobstructed.",
            diagnostics
        );
    }

    const marks = best.marks.map(mark => ({
        x: mark.x / scaleX,
        y: mark.y / scaleY
    }));

    diagnostics.elapsed_ms = Math.round(
        performance.now() - started
    );

    diagnostics.score = Number(
        best.score.toFixed(4)
    );

    Object.defineProperty(
        marks,
        "diagnostics",
        {
            value: diagnostics,
            enumerable: false
        }
    );

    return marks;
}

/* TEMPLATE DATABASE LOOKUP */

async function getTemplateCoordinates(
    db,
    templateId,
    electionId
) {
    const [templates] = await db.execute(
        `SELECT template_id, election_id, paper_size
         FROM ballot_templates
         WHERE template_id = ?
           AND election_id = ?
         LIMIT 1`,
        [templateId, electionId]
    );

    if (!templates.length) return null;

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
        [templateId, electionId, electionId]
    );

    return {
        template: templates[0],
        coordinates
    };
}

/* HOMOGRAPHY */

function solve8(A, b) {
    for (let i = 0; i < 8; i++) {
        let pivot = i;

        for (let j = i + 1; j < 8; j++) {
            if (
                Math.abs(A[j][i]) >
                Math.abs(A[pivot][i])
            ) {
                pivot = j;
            }
        }

        [A[i], A[pivot]] = [A[pivot], A[i]];
        [b[i], b[pivot]] = [b[pivot], b[i]];

        if (Math.abs(A[i][i]) < 1e-10) {
            throw new Error(
                "Invalid marker geometry."
            );
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

    if (Math.abs(d) < 1e-10) return null;

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

/* POSITION VALIDATION */

function validatePositionVotes(grouped) {
    const positions = [...grouped.values()].map(position => {
        const markedCandidates = position.candidates.filter(
            candidate => candidate.filled
        );

        const marked = markedCandidates.length;

        const overvoted =
            marked > position.max_selection;

        const unclear = position.candidates.some(
            candidate => candidate.unclear
        );

        let result = "BLANK";

        // Unclear shading also takes priority in an overvoted position.
        if (unclear) {
            result = "NEEDS_REVIEW";
        } else if (overvoted) {
            result = "SKIPPED_OVERVOTE";
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

async function analyzeBubbleCoordinates(
    image,
    H,
    coordinates,
    paper
) {
    if (
        !Array.isArray(coordinates) ||
        !coordinates.length
    ) {
        throw new Error(
            "No saved bubble coordinates found."
        );
    }

    /*
     * MAIN PIPELINE CHANGE:
     * OpenCV runs for both actual counting and preview.
     */
    const adaptive = await analyzeBubbles(
        image,
        H,
        coordinates,
        paper
    );

    const measurements = new Map(
        adaptive.candidates.map(item => [
            item.candidate_id,
            item
        ])
    );

    if (measurements.size !== coordinates.length) {
        throw new Error(
            "OpenCV candidate measurements do not match the template."
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

        const measurement = measurements.get(candidateId);

        if (!measurement) {
            throw new Error(
                "Missing OpenCV candidate measurement."
            );
        }

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

        position.candidates.push({
            candidate_id: candidateId,
            name: coord.candidate_name,
            filled: measurement.selected,
            unclear: measurement.unclear === true,
            fill_intensity:
                Math.round(measurement.marked * 10000) / 100,
            contrast:
                Math.round(measurement.average * 100) / 100,
            adaptive_dark_percent:
                measurement.adaptive_dark_percent,
            quality_reasons:
                measurement.quality_reasons || []
        });

        if (process.env.OMR_DEBUG === "true") {
            console.info("OMR BUBBLE TEST:", {
                candidate: coord.candidate_name,
                position: coord.position_name,
                selected: measurement.selected,
                unclear: measurement.unclear,
                average: measurement.average,
                marked: measurement.marked,
                baseline: measurement.baseline
            });
        }
    }

    return {
        ...validatePositionVotes(grouped),
        opencv: adaptive
    };
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
            [
                qr.ballot_id,
                qr.election_id,
                qr.template_id
            ]
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
            error.message ===
            "Invalid CampusVote ballot QR code.";

        if (!invalid) {
            console.error(
                "QR verification error:",
                error
            );
        }

        return res.status(invalid ? 422 : 500).json({
            valid: false,
            message: invalid
                ? error.message
                : "QR verification failed."
        });
    }
};

/* MAIN SCAN AND COUNT */

exports.uploadAndProcess = async (req, res) => {
    let db = null;
    let transactionStarted = false;

    const preview = req.omrPreview === true;
    const counting = req.omrCounting === true;

    const timingStart = performance.now();
    const timingMarks = {};

    let previousStage = timingStart;
    let preprocessing = null;

    const markTime = stage => {
        const now = performance.now();
        timingMarks[stage] = Math.round(now - previousStage);
        previousStage = now;
    };

    const processingDetails = () => ({
        processing_ms:
            Math.round(performance.now() - timingStart),

        ...(preprocessing ? { preprocessing } : {}),

        ...(process.env.OMR_TIMING_ENABLED === "true"
            ? { timing_ms: { ...timingMarks } }
            : {})
    });

    const fail = (code, message, extra = {}) =>
        res.status(code).json({
            success: false,
            preview_only: !counting,
            counted: false,
            message,
            ...processingDetails(),
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
            return fail(
                403,
                "Invalid OMR processing mode."
            );
        }

        if (
            counting &&
            process.env.OMR_COUNTING_ENABLED !== "true"
        ) {
            return fail(
                403,
                "Live counting is disabled."
            );
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

        let qr;
        let prepared;

        try {
            prepared = await prepareBallotImage(
                req.file.path
            );

            preprocessing = prepared.preprocessing;
            markTime("preprocess_ms");

            if (
                Math.min(
                    prepared.image.width,
                    prepared.image.height
                ) < 500 ||
                Math.max(
                    prepared.image.width,
                    prepared.image.height
                ) < 700
            ) {
                return fail(
                    422,
                    "Ballot image is too small. Move closer and keep all four markers visible."
                );
            }

            const decodedQR = await readImageQR(
                prepared.image,
                { timeoutMs: 6000 }
            );

            qr = parseQR(decodedQR.data);

            prepared = orientPreparedBallot(
                prepared,
                decodedQR.location
            );

            preprocessing = {
                ...prepared.preprocessing,
                qr_attempts: decodedQR.attempts,
                qr_elapsed_ms: decodedQR.elapsedMs
            };

            markTime("qr_ms");
        } catch (error) {
            markTime(
                prepared ? "qr_ms" : "preprocess_ms"
            );

            return fail(
                error.httpStatus || 422,
                error.message
            );
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
            return fail(
                422,
                "Unregistered ballot."
            );
        }

        const ballotStatus = ballots[0].status;

        if (
            !["ISSUED", "CAST"].includes(ballotStatus)
        ) {
            return fail(
                409,
                "Ballot is not eligible for scanning.",
                {
                    status: ballotStatus,
                    duplicate: ballotStatus === "COUNTED"
                }
            );
        }

        const record = await getTemplateCoordinates(
            db,
            templateId,
            electionId
        );

        if (!record) {
            return fail(
                404,
                "Ballot template not found."
            );
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
            coordinate => Number(coordinate.x_pos)
        );

        if (savedX.every(x => x === oldX)) {
            return fail(
                422,
                "This template uses the old A5 landscape layout."
            );
        }

        // Release read connection during image processing.
        db.release();
        db = null;

        markTime("template_lookup_ms");

        const image = prepared.image;

        const info = {
            width: image.width,
            height: image.height
        };

        let marks;
        let H;

        try {
            /*
             * SHADOW CHANGE:
             * Dynamic marker mask replaces the old fixed threshold.
             */
            marks = await findMarkers(image);

            if (
                !Array.isArray(marks) ||
                marks.length !== 4
            ) {
                throw new Error(
                    "Four registration markers are required."
                );
            }

            const markerPoints = [
                { x: mm(9.5), y: mm(7.5) },
                { x: mm(138.5), y: mm(7.5) },
                { x: mm(9.5), y: mm(200.5) },
                { x: mm(138.5), y: mm(200.5) }
            ];

            const distance = (a, b) => Math.hypot(
                a.x - b.x,
                a.y - b.y
            );

            const top = distance(marks[0], marks[1]);
            const bottom = distance(marks[2], marks[3]);
            const left = distance(marks[0], marks[2]);
            const right = distance(marks[1], marks[3]);

            const measuredRatio =
                ((top + bottom) / 2) /
                ((left + right) / 2);

            const expectedRatio =
                (
                    markerPoints[1].x -
                    markerPoints[0].x
                ) /
                (
                    markerPoints[2].y -
                    markerPoints[0].y
                );

            // Use the same tolerance constants as candidate selection.
            if (
                !Number.isFinite(measuredRatio) ||
                Math.abs(
                    measuredRatio - expectedRatio
                ) > ALIGNMENT_LIMITS.ratioError ||
                Math.abs(top - bottom) /
                Math.max(top, bottom) >
                ALIGNMENT_LIMITS.widthError ||
                Math.abs(left - right) /
                Math.max(left, right) >
                ALIGNMENT_LIMITS.heightError
            ) {
                throw new Error(
                    "Registration markers do not match one A5 portrait ballot."
                );
            }

            H = homography(markerPoints, marks);

            // Bind QR identity to the same detected page.
            const inverseH = homography(
                marks,
                markerPoints
            );

            const qrCorners = [
                "topLeftCorner",
                "topRightCorner",
                "bottomLeftCorner",
                "bottomRightCorner"
            ].map(key => prepared.qrLocation[key]);

            if (qrCorners.some(point => !point)) {
                throw new Error(
                    "QR corners could not be verified against the ballot."
                );
            }

            const pageQrCorners = qrCorners.map(
                point => project(
                    inverseH,
                    point.x,
                    point.y
                )
            );

            if (
                pageQrCorners.some(point =>
                    !point ||
                    ![point.x, point.y].every(Number.isFinite) ||
                    point.x < 0 ||
                    point.x > paper.width ||
                    point.y < 0 ||
                    point.y > paper.height
                )
            ) {
                throw new Error(
                    "QR lies outside the detected ballot frame. Photograph one complete A5 ballot."
                );
            }

            const qrCenter = project(
                inverseH,
                qrCorners.reduce(
                    (sum, point) => sum + point.x,
                    0
                ) / 4,
                qrCorners.reduce(
                    (sum, point) => sum + point.y,
                    0
                ) / 4
            );

            if (
                !qrCenter ||
                ![qrCenter.x, qrCenter.y].every(Number.isFinite) ||
                qrCenter.x < paper.width * 0.55 ||
                qrCenter.x > paper.width ||
                qrCenter.y < 0 ||
                qrCenter.y > paper.height * 0.25
            ) {
                throw new Error(
                    "QR and markers do not belong to one upright A5 ballot. Photograph one ballot only."
                );
            }

            markTime("alignment_ms");
        } catch (error) {
            markTime("alignment_ms");

            return fail(
                422,
                "Alignment failed. Retake the photo. " +
                error.message,
                (
                    process.env.OMR_TIMING_ENABLED === "true" &&
                    error.diagnostics
                )
                    ? {
                        alignment_diagnostic:
                            error.diagnostics
                    }
                    : {}
            );
        }

        let analysis;

        try {
            /*
             * MAIN PIPELINE CHANGE:
             * This awaits OpenCV for both preview and counting.
             */
            analysis = await analyzeBubbleCoordinates(
                image,
                H,
                record.coordinates,
                paper
            );

            markTime("bubble_analysis_ms");
        } catch (error) {
            markTime("bubble_analysis_ms");

            return fail(
                error.httpStatus || 422,
                "Bubble analysis failed. " + error.message
            );
        }

        // Optional diagnostics reuse the main result.
        const openCvDiagnostic = analysis.opencv;

        markTime("preview_diagnostic_ms");

        const { positions, votes } = analysis;

        const needsReview = positions.filter(
            position => position.unclear
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
            // Hindi lahat ng zero valid votes ay blank ballot.
            const shadedCount = positions.reduce(
                (total, position) => total + position.marked,
                0
            );

            const overvoteOnly = shadedCount > 0 &&
                positions.some(position => position.overvoted);

            const reason = overvoteOnly
                ? "NO_VALID_VOTES_OVERVOTE"
                : "BLANK_BALLOT";

            return fail(
                422,
                overvoteOnly
                    ? "No valid votes: shaded selections exceed the allowed limit. No votes saved."
                    : "Blank ballot detected. No votes saved. Submit a marked ballot for scanning.",
                {
                    reason,
                    selected_bubbles: shadedCount,
                    overvotes: positions.filter(
                        position => position.overvoted
                    ).length,
                    positions,
                    diagnostic: {
                        image: {
                            width: info.width,
                            height: info.height
                        },
                        registration_marks: marks.map(mark => ({
                            x: Math.round(mark.x * 10) / 10,
                            y: Math.round(mark.y * 10) / 10
                        })),
                        positions: positions.map(position => ({
                            position: position.position_name,
                            result: position.result,
                            candidates: position.candidates.map(
                                candidate => ({
                                    name: candidate.name,
                                    contrast: candidate.contrast,
                                    fill_intensity: candidate.fill_intensity,
                                    filled: candidate.filled,
                                    unclear: candidate.unclear
                                })
                            )
                        }))
                    }
                }
            );
        }

        if (counting) {
            db = await pool.getConnection();

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
                [qr.ballot_id, electionId, templateId]
            );

            if (!locked.length) {
                reject(
                    422,
                    "Unregistered ballot."
                );
            }

            if (
                !["ISSUED", "CAST"].includes(
                    locked[0].status
                )
            ) {
                reject(
                    409,
                    "Duplicate, void or unavailable ballot.",
                    {
                        duplicate:
                            locked[0].status === "COUNTED"
                    }
                );
            }

            // Batch validation retains exact candidate-position checks.
            const candidateIds = votes.map(
                vote => vote.candidate_id
            );

            const candidatePlaceholders =
                candidateIds.map(() => "?").join(",");

            const [candidateRows] = await db.execute(
                `SELECT c.candidate_id, c.position_id
                 FROM candidates c
                 INNER JOIN positions p
                   ON p.position_id = c.position_id
                 WHERE c.candidate_id IN (${candidatePlaceholders})
                   AND c.election_id = ?
                   AND p.election_id = ?`,
                [
                    ...candidateIds,
                    electionId,
                    electionId
                ]
            );

            const validCandidates = new Map(
                candidateRows.map(row => [
                    Number(row.candidate_id),
                    Number(row.position_id)
                ])
            );

            if (
                votes.some(vote =>
                    validCandidates.get(vote.candidate_id) !==
                    vote.position_id
                )
            ) {
                reject(
                    422,
                    "Invalid candidate or position for this election."
                );
            }

            const votePlaceholders = votes.map(
                () => "(?, ?, ?, ?)"
            ).join(",");

            const voteValues = votes.flatMap(vote => [
                qr.ballot_id,
                vote.candidate_id,
                vote.position_id,
                vote.fill_intensity
            ]);

            await db.execute(
                `INSERT INTO ballot_votes
                    (
                        ballot_id,
                        candidate_id,
                        position_id,
                        fill_intensity
                    )
                 VALUES ${votePlaceholders}`,
                voteValues
            );

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
                [qr.ballot_id, electionId, templateId]
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

        markTime("database_processing_ms");

        const selectedBubbles = positions.reduce(
            (total, position) =>
                total + position.marked,
            0
        );

        const overvotes = positions.filter(
            position => position.overvoted
        ).length;

        const skippedPositions = positions.filter(
            position =>
                position.result.startsWith("SKIPPED")
        ).length;

        return res.status(200).json({
            success: true,
            valid: true,
            preview_only: !counting,
            counted: counting,
            duplicate: false,

            ...processingDetails(),

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
            omr_method: analysis.opencv.method,
            marker_detection: marks.diagnostics,
            sensitivity: "Adaptive balanced",

            selected_bubbles: selectedBubbles,
            overvotes,
            skipped_positions: skippedPositions,

            review_required: needsReview.length > 0,

            unclear_positions: needsReview.map(
                position => position.position_name
            ),

            saved_votes: counting ? votes.length : 0,

            positions,

            ...(
                preview &&
                    process.env.OMR_OPENCV_DIAGNOSTICS === "true"
                    ? {
                        opencv_diagnostic: openCvDiagnostic
                    }
                    : {}
            ),

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

        console.error(
            "OMR processing error:",
            error
        );

        if (error.httpStatus) {
            return fail(
                error.httpStatus,
                error.message,
                {
                    duplicate:
                        error.duplicate === true
                }
            );
        }

        if (error.code === "ER_DUP_ENTRY") {
            return fail(
                409,
                "Duplicate vote record. No votes saved.",
                { duplicate: true }
            );
        }

        return fail(
            500,
            "OMR processing failed. Check backend logs."
        );
    } finally {
        if (
            process.env.OMR_TIMING_ENABLED === "true"
        ) {
            console.info(
                "OMR processing timings:",
                {
                    mode: counting ? "COUNTING" : "PREVIEW",
                    status: res.statusCode,
                    total_ms: Math.round(
                        performance.now() - timingStart
                    ),
                    stage_ms: timingMarks
                }
            );
        }

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

/* LIVE TALLIES */

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
        console.error(
            "Live tallies error:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Failed to load live tallies."
        });
    }
};