
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

const uploadDir = path.join(
    os.tmpdir(),
    "campusvote-omr-uploads"
);

const MAX_SIZE = 10 * 1024 * 1024;

const extensions = {
    "image/jpeg": [".jpg", ".jpeg"],
    "image/png": [".png"],
    "image/webp": [".webp"]
};

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

const upload = multer({
    storage,

    limits: {
        fileSize: MAX_SIZE,
        files: 1,
        fields: 10
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

function uploadBallot(req, res, next) {
    upload.single("ballot_image")(req, res, error => {
        if (error) {
            return next(error);
        }

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "Ballot image is required."
            });
        }

        next();
    });
}

router.use(
    verifyToken,
    middleware.requireRole(
        "super_admin",
        "committee"
    )
);

router.get(
    "/tallies/:election_id",
    omrController.getLiveTallies
);

router.post(
    "/verify-qr",
    express.json({
        limit: "32kb"
    }),
    omrController.verifyQR
);

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

router.post(
    "/scan",
    (req, res, next) => {
        if (
            process.env.OMR_COUNTING_ENABLED !== "true"
        ) {
            return res.status(403).json({
                success: false,
                counting_enabled: false,
                message: "Live counting is disabled. Use preview mode."
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
    console.error("OMR router error:", error);

    if (error instanceof multer.MulterError) {
        return res.status(400).json({
            success: false,
            message:
                error.code === "LIMIT_FILE_SIZE"
                    ? "Image exceeds the 10MB limit."
                    : error.message
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
