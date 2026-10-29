"use strict";

const express = require("express");
const router = express.Router();

const electionControl = require("./electionControl.controller");
const verifyToken = require("../../sheared/middleware");

// PUBLIC ENDPOINTS

router.get(
    "/:election_id/status",
    electionControl.getStatus
);

router.get(
    "/:election_id/candidates",
    electionControl.getPublicCandidates
);

// PROTECTED ENDPOINTS

router.use(
    verifyToken,
    verifyToken.requireRole(
        "super_admin",
        "committee",
        "adviser"
    )
);

// ELECTION SCHEDULE

router.patch(
    "/:election_id/schedule",
    electionControl.setSchedule
);

// START ELECTION

router.post(
    "/:election_id/start",
    electionControl.startElection
);

// STOP VOTING

router.post(
    "/:election_id/stop",
    electionControl.stopVoting
);

// MASK CANDIDATE NAMES

router.post(
    "/:election_id/mask",
    electionControl.toggleMaskNames
);

// LIVE COUNTING STATUS

router.get(
    "/:election_id/counting-status",
    electionControl.getCountingStatus
);

// FINISH SCANNING

router.post(
    "/:election_id/finish-scanning",
    electionControl.finishScanning
);

// UNUSED BALLOT MANAGEMENT

router.get(
    "/:election_id/unused-ballots",
    electionControl.listUnusedBallots
);

router.post(
    "/:election_id/void-unused-ballots",
    verifyToken.requireRole("super_admin", "committee"),
    electionControl.voidUnusedBallots
);

module.exports = router;