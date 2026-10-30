
"use strict";

const express = require("express");
const router = express.Router();

const dashboardController = require("./dashboard.controller");
const verifyToken = require("../../sheared/middleware");

// Public dashboard
router.get(
    "/:election_id/status",
    dashboardController.getElectionStatus
);

router.get(
    "/:election_id/candidates",
    dashboardController.getCandidates
);

router.get(
    "/:election_id/tallies",
    dashboardController.getTallies
);

router.get(
    "/:election_id/overview",
    dashboardController.getOverview
);

// Protected live results
router.get("/:election_id/admin-overview",verifyToken,verifyToken.requireRole("super_admin","committee","adviser"),
    dashboardController.getAdminOverview
);

module.exports = router;
