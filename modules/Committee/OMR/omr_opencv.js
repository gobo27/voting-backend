
"use strict";

const sharp = require("sharp");

let cvPromise;

// Load OpenCV once para hindi paulit-ulit.
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
                    "OpenCV adaptive threshold is unavailable."
                );
            }

            return cv;
        })();
    }

    return cvPromise;
}

// I-map ang ballot coordinates sa camera image.
function project(H, x, y) {
    const d = H[6] * x + H[7] * y + 1;

    if (
        !Number.isFinite(d) ||
        Math.abs(d) < 1e-10
    ) {
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

// OpenCV preview diagnostics lang; hindi pa nagbibilang ng votes.
async function analyzePreview(
    imagePath,
    H,
    coordinates
) {
    const cv = await getOpenCV();

    const metadata = await sharp(imagePath)
        .rotate()
        .metadata();

    const sourceWidth =
        metadata.autoOrient?.width ||
        metadata.width;

    const sourceHeight =
        metadata.autoOrient?.height ||
        metadata.height;

    // Resize para hindi masyadong mabigat sa server.
    const scale = Math.min(
        1,
        1600 / Math.max(
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

    // Convert ballot image to grayscale.
    const { data } = await sharp(imagePath)
        .rotate()
        .resize(width, height, {
            fit: "fill"
        })
        .grayscale()
        .raw()
        .toBuffer({
            resolveWithObject: true
        });
    // Actual resize factors.
    const scaleX = width / sourceWidth;
    const scaleY = height / sourceHeight;

    const diameters = [];

    for (const coord of coordinates) {
        const x = Number(coord.x_pos);
        const y = Number(coord.y_pos);
        const w = Number(coord.width);
        const h = Number(coord.height);

        const cx = x + w / 2;
        const cy = y + h / 2;

        const points = [
            project(H, x, cy),
            project(H, x + w, cy),
            project(H, cx, y),
            project(H, cx, y + h)
        ];

        if (points.some(pt =>
            !pt ||
            !Number.isFinite(pt.x) ||
            !Number.isFinite(pt.y)
        )) {
            continue;
        }

        const [left, right, top, bottom] = points;

        const projectedWidth = Math.hypot(
            (right.x - left.x) * scaleX,
            (right.y - left.y) * scaleY
        );

        const projectedHeight = Math.hypot(
            (bottom.x - top.x) * scaleX,
            (bottom.y - top.y) * scaleY
        );

        const diameter = Math.max(
            projectedWidth,
            projectedHeight
        );

        if (Number.isFinite(diameter) && diameter > 0) {
            diameters.push(diameter);
        }
    }

    if (!diameters.length) {
        throw new Error(
            "No valid projected bubble dimensions."
        );
    }

    diameters.sort((a, b) => a - b);

    const middle = Math.floor(diameters.length / 2);

    const typicalDiameter = diameters.length % 2
        ? diameters[middle]
        : (diameters[middle - 1] + diameters[middle]) / 2;

    const imageLimit = Math.min(width, height);
    const maxOddWindow = imageLimit % 2
        ? imageLimit
        : imageLimit - 1;

    if (maxOddWindow < 3) {
        throw new Error(
            "Image is too small for adaptive thresholding."
        );
    }

    let blockSize = Math.max(
        31,
        Math.ceil(typicalDiameter * 3)
    );

    if (blockSize % 2 === 0) {
        blockSize++;
    }

    blockSize = Math.min(blockSize, maxOddWindow);

    let src;
    let binary;

    try {
        src = cv.matFromArray(
            height,
            width,
            cv.CV_8UC1,
            data
        );

        binary = new cv.Mat();

        // Adaptive threshold para sa uneven lighting.
        cv.adaptiveThreshold(
            src,
            binary,
            255,
            cv.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv.THRESH_BINARY_INV,
            blockSize,
            12
        );

        const result = [];

        // Analyze ang bawat candidate bubble.
        for (const coord of coordinates) {
            const x = Number(coord.x_pos);
            const y = Number(coord.y_pos);
            const w = Number(coord.width);
            const h = Number(coord.height);

            let dark = 0;
            let sampled = 0;

            // Gitnang bahagi lang para iwas sa printed oval outline.
            for (let j = -8; j <= 8; j++) {
                for (let i = -8; i <= 8; i++) {
                    const nx = i / 8;
                    const ny = j / 8;

                    if (
                        Math.hypot(nx, ny) > 0.48
                    ) {
                        continue;
                    }

                    const pt = project(
                        H,
                        x + w / 2 + nx * w / 2,
                        y + h / 2 + ny * h / 2
                    );

                    if (!pt) {
                        continue;
                    }

                    const px = Math.round(
                        pt.x * scale
                    );

                    const py = Math.round(
                        pt.y * scale
                    );

                    if (
                        px < 0 ||
                        py < 0 ||
                        px >= width ||
                        py >= height
                    ) {
                        continue;
                    }

                    sampled++;

                    if (
                        binary.data[
                        py * width + px
                        ] > 0
                    ) {
                        dark++;
                    }
                }
            }

            // Ibalik ang dark coverage ng bawat candidate.
            result.push({
                candidate_id:
                    Number(coord.candidate_id),

                candidate_name:
                    coord.candidate_name,

                position_id:
                    Number(coord.position_id),

                adaptive_dark_percent:
                    sampled
                        ? Math.round(
                            10000 * dark / sampled
                        ) / 100
                        : null,

                samples: sampled
            });
        }

        return {
            method:"opencv_adaptive_threshold_diagnostic",
            width,
            height,
            block_size: blockSize,
            candidates: result
        };

    } finally {
        // Free OpenCV memory para iwas memory leak.
        if (binary) {
            binary.delete();
        }

        if (src) {
            src.delete();
        }
    }
}

module.exports = {
    analyzePreview
};
