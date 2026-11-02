
"use strict";

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const omrController = require("./omr.controller");
const middleware = require("../../sheared/middleware");

const router = express.Router();
const verifyToken = middleware.verifyToken || middleware;

// UPLOAD CONFIGURATION

const uploadDir = path.join(
    os.tmpdir(),
    "campusvote-omr-uploads"
);

// Maximum image size: 30MB
const MAX_SIZE = 30 * 1024 * 1024;

const extensions = {
    "image/jpeg": [".jpg", ".jpeg"],
    "image/png": [".png"],
    "image/webp": [".webp"]
};

// DISK STORAGE

const storage = multer.diskStorage({
    destination(req, file, cb) {
        try {
            fs.mkdirSync(uploadDir, {
                recursive: true
            });

            cb(null, uploadDir);
        } catch (error) {
            cb(error);
        }
    },

    filename(req, file, cb) {
        const ext = path.extname(
            file.originalname || ""
        ).toLowerCase();

        cb(
            null,
            `${Date.now()}-${crypto.randomUUID()}${ext}`
        );
    }
});

// MULTER CONFIGURATION

const upload = multer({
    storage,

    limits: {
        fileSize: MAX_SIZE,
        files: 1,
        fields: 10,
        parts: 12
    },

    fileFilter(req, file, cb) {
        const mime = String(
            file.mimetype || ""
        ).toLowerCase();

        const ext = path.extname(
            file.originalname || ""
        ).toLowerCase();

        if (!extensions[mime]?.includes(ext)) {
            return cb(
                new Error(
                    "Only matching JPG, PNG or WEBP images are allowed."
                )
            );
        }

        cb(null, true);
    }
});

// BALLOT IMAGE UPLOAD MIDDLEWARE

function uploadBallot(req, res, next) {
    upload.single("ballot_image")(
        req,
        res,
        error => {
            if (error) {
                console.error(
                    "[OMR] Upload rejected:",
                    {
                        code: error.code || null,
                        field: error.field || null,
                        message: error.message,
                        contentType:
                            req.headers["content-type"]
                    }
                );

                return next(error);
            }

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Ballot image is required."
                });
            }

            console.log(
                "[OMR] Image received:",
                {
                    field: req.file.fieldname,
                    name: req.file.originalname,
                    mime: req.file.mimetype,
                    sizeMB: (
                        req.file.size /
                        (1024 * 1024)
                    ).toFixed(2)
                }
            );

            next();
        }
    );
}

// AUTHENTICATION AND ROLE ACCESS

router.use(
    verifyToken,
    middleware.requireRole(
        "super_admin",
        "committee"
    )
);

// LIVE TALLIES

router.get(
    "/tallies/:election_id",
    omrController.getLiveTallies
);

// VERIFY BALLOT QR

router.post(
    "/verify-qr",
    express.json({
        limit: "32kb"
    }),
    omrController.verifyQR
);

// PREVIEW MODE - NO DATABASE COUNTING

router.post(
    "/preview",
    uploadBallot,
    (req, res, next) => {
        req.omrPreview = true;
        req.omrCounting = false;

        next();
    },
    omrController.uploadAndProcess
);

// LIVE SCANNING AND COUNTING

router.post(
    "/scan",

    (req, res, next) => {
        if (
            process.env.OMR_COUNTING_ENABLED !== "true"
        ) {
            return res.status(403).json({
                success: false,
                counting_enabled: false,
                message:
                    "Live counting is disabled. " +
                    "Use preview mode."
            });
        }

        next();
    },

    uploadBallot,

    (req, res, next) => {
        req.omrPreview = false;
        req.omrCounting = true;

        next();
    },

    omrController.uploadAndProcess
);


router.use((error, req, res, next) => {
    console.error("[OMR] Router error:", {
        code: error.code || null,
        field: error.field || null,
        message: error.message
    });

    if (error instanceof multer.MulterError) {
        let message = error.message;

        switch (error.code) {
            case "LIMIT_FILE_SIZE":
                message =
                    "Image exceeds the 30MB limit.";
                break;

            case "LIMIT_FILE_COUNT":
                message =
                    "Too many image files. " +
                    "Only one ballot image is allowed.";
                break;

            case "LIMIT_UNEXPECTED_FILE":
                message =
                    "Unexpected image field: " +
                    (error.field || "unknown") +
                    ". Expected ballot_image.";
                break;

            case "LIMIT_PART_COUNT":
                message =
                    "Too many multipart form parts.";
                break;

            case "LIMIT_FIELD_COUNT":
                message =
                    "Too many form fields.";
                break;
        }

        return res.status(400).json({
            success: false,
            code: error.code,
            message
        });
    }

    if (
        error.message ===
        "Only matching JPG, PNG or WEBP images are allowed."
    ) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }

    return res.status(500).json({
        success: false,
        message: "OMR upload failed."
    });
});

module.exports = router;
