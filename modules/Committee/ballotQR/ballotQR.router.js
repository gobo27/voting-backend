
"use strict";

const express = require("express");
const router = express.Router();

const ballotController = require("../creatingballot/creatingballot.controller");
const qrController = require("../ballotQR/ballotQR.controller");

const verifyToken = require("../../sheared/middleware");

router.use(
    verifyToken,
    verifyToken.requireRole(
        "super_admin",
        "committee",
        "adviser"
    )
);

// BALLOT TEMPLATES

router.post(
    "/templates",
    ballotController.createTemplate
);

router.post(
    "/templates/complete",
    ballotController.createCompleteTemplate
);

router.get(
    "/templates/election/:election_id",
    ballotController.getTemplatesByElection
);

router.get(
    "/templates/:template_id",
    ballotController.getTemplate
);

router.post(
    "/templates/:template_id/coordinates",
    ballotController.addGridCoordinate
);

router.delete(
    "/templates/:template_id",
    ballotController.deleteTemplate
);

// QR PRINT BATCHES

router.post(
    "/qr/batches",
    qrController.createBatch
);

router.get(
    "/qr/batches/election/:election_id",
    qrController.listBatchesByElection
);

router.get(
    "/qr/batches/:batch_id",
    qrController.getBatch
);

// PRINT TRACKING

router.post(
    "/qr/batches/:batch_id/confirm-print",
    verifyToken.requireRole("super_admin", "committee"),
    qrController.confirmPrint
);

router.get(
    "/qr/print-summary/election/:election_id",
    qrController.getPrintSummary
);

module.exports = router;
