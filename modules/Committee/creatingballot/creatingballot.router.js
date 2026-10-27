
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

// ==========================================
// BALLOT TEMPLATE ENDPOINTS
// ==========================================

// Create ballot template
router.post(
    "/templates",
    ballotController.createTemplate
);

// Save complete ballot template
router.post(
    "/templates/complete",
    ballotController.createCompleteTemplate
);

// Get saved ballots by election
router.get(
    "/templates/election/:election_id",
    ballotController.getTemplatesByElection
);

// Get specific saved ballot
router.get(
    "/templates/:template_id",
    ballotController.getTemplate
);

// Add OMR grid coordinates
router.post(
    "/templates/:template_id/coordinates",
    ballotController.addGridCoordinate
);

// Delete unused saved ballot
router.delete(
    "/templates/:template_id",
    ballotController.deleteTemplate
);

// ==========================================
// QR BALLOT PRINTING ENDPOINTS
// ==========================================

// Generate new unique QR batch
router.post(
    "/qr/batches",
    qrController.createBatch
);

// NEW: Get existing QR batches by election
router.get(
    "/qr/batches/election/:election_id",
    qrController.listBatchesByElection
);

// Reprint existing QR batch
router.get(
    "/qr/batches/:batch_id",
    qrController.getBatch
);

module.exports = router;
