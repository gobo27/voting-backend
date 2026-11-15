
"use strict";

const express = require("express");
const router = express.Router();

const verifyToken = require(
    "../../../modules/sheared/middleware"
);

const controller = require(
    "./electionArchive.controller"
);

const workflow = require(
    "./electionArchive.workflow"
);

// Signed PDF link from Adviser email
// Existing JWT validation remains in the controller.
router.get(
    "/report-download",
    controller.downloadSignedReport
);

// SUPER ADMIN ONLY
router.use(
    verifyToken,
    verifyToken.requireRole("super_admin")
);

router.get("/", controller.list);
router.get("/:id/details", controller.details);
router.get("/:id/report-advisers",controller.reportAdvisers);
router.post("/:id/notify-advisers", workflow.notify);
router.get("/:id/report-status",workflow.status);
router.get("/:id/report.pdf",controller.downloadPdf);
router.post("/:id/archive", workflow.archive);
router.post("/", controller.create);

module.exports = router;
