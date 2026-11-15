"use strict";

const express = require("express");
const router = express.Router();

const verifyToken = require("../../../modules/sheared/middleware");
const controller = require("./electionArchive.controller");

// SUPER ADMIN ONLY
router.use(
    verifyToken,
    verifyToken.requireRole("super_admin")
);
router.get("/report-download",controller.downloadSignedReport);
router.get("/", controller.list);
router.get("/:id/details", controller.details);
router.get("/:id/report-advisers",controller.reportAdvisers);
// Send report links to selected Advisers
router.post("/:id/notify-advisers",controller.notifyReportAdvisers);
router.get("/:id/report.pdf", controller.downloadPdf);
router.post("/:id/archive", controller.archive);
router.post("/", controller.create);

module.exports = router;