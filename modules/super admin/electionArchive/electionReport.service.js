
"use strict";

const PDFDocument = require("pdfkit");
const db = require("../../../config/db");

const MAROON = "#800000";

function safeText(value) {
    return String(value ?? "-")
        .replace(/[\r\n\t]+/g, " ")
        .trim() || "-";
}

function formatDate(value) {
    if (!value) return "Not recorded";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return safeText(value);
    }

    return new Intl.DateTimeFormat("en-PH", {
        timeZone: "Asia/Manila",
        dateStyle: "medium",
        timeStyle: "short"
    }).format(date);
}

// Get election report data from existing tables
async function fetchReportData(electionId) {
    const [elections] = await db.execute(
        `SELECT election_id, title, school_level,
                start_time, end_time, status,
                archived_at, voting_closed_at,
                scanning_closed_at
         FROM elections
         WHERE election_id = ?
         LIMIT 1`,
        [electionId]
    );

    if (!elections.length) return null;

    const [positions] = await db.execute(
        `SELECT position_id, title, max_selection,
                display_order
         FROM positions
         WHERE election_id = ?
         ORDER BY display_order, position_id`,
        [electionId]
    );

    const [candidates] = await db.execute(
        `SELECT candidate_id, position_id, name,
                course, grade_level, party_list
         FROM candidates
         WHERE election_id = ?
         ORDER BY position_id, display_order, candidate_id`,
        [electionId]
    );

    const [votes] = await db.execute(
        `SELECT v.position_id, v.candidate_id,
                COUNT(*) AS total_votes
         FROM ballot_votes v
         JOIN issued_ballots b
           ON b.ballot_id = v.ballot_id
         WHERE b.election_id = ?
           AND b.status = 'COUNTED'
         GROUP BY v.position_id, v.candidate_id`,
        [electionId]
    );

    const [ballots] = await db.execute(
        `SELECT status, COUNT(*) AS total
         FROM issued_ballots
         WHERE election_id = ?
         GROUP BY status`,
        [electionId]
    );

    const [scans] = await db.execute(
        `SELECT COUNT(*) AS total
         FROM scanned_ballots
         WHERE election_id = ?`,
        [electionId]
    );

    return {
        election: elections[0],
        positions,
        candidates,
        votes,
        ballots,
        scannedCount: Number(scans[0]?.total || 0)
    };
}

// Generate report as PDF buffer
function createPdf(data) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: "A4",
            margin: 48,
            info: {
                Title: "CampusVote Election Report",
                Author: "CampusVote"
            }
        });

        const chunks = [];

        doc.on("data", chunk => chunks.push(chunk));
        doc.on("error", reject);
        doc.on("end", () => {
            resolve(Buffer.concat(chunks));
        });

        const pageBottom = () => doc.page.height - 58;

        function ensureSpace(height = 45) {
            if (doc.y + height > pageBottom()) {
                doc.addPage();
            }
        }

        function heading(text) {
            ensureSpace(60);

            doc.moveDown(0.7);
            doc.font("Helvetica-Bold")
                .fontSize(13)
                .fillColor(MAROON)
                .text(text);

            doc.moveDown(0.4);
            doc.fillColor("#222222");
        }

        function detail(label, value) {
            ensureSpace(32);

            doc.font("Helvetica-Bold")
                .fontSize(9)
                .text(label + ": ", {
                    continued: true
                });

            doc.font("Helvetica")
                .text(safeText(value));

            doc.moveDown(0.3);
        }

        function item(value) {
            ensureSpace(40);

            doc.font("Helvetica")
                .fontSize(9)
                .fillColor("#222222")
                .text(safeText(value), {
                    lineGap: 3
                });

            doc.moveDown(0.35);
        }

        const election = data.election;

        // Header
        doc.rect(0, 0, doc.page.width, 10)
            .fill(MAROON);

        doc.y = 50;

        doc.font("Helvetica-Bold")
            .fontSize(20)
            .fillColor(MAROON)
            .text("CAMPUSVOTE");

        doc.font("Helvetica")
            .fontSize(13)
            .fillColor("#333333")
            .text("Official Election Data Report");

        doc.moveDown(0.5);

        doc.fontSize(9)
            .fillColor("#666666")
            .text(
                election.archived_at
                    ? "Archived election record"
                    : "Preview - Election not yet archived"
            );

        // Election details
        heading("Election Information");

        detail("Election ID", election.election_id);
        detail("Election title", election.title);
        detail("School level", election.school_level);
        detail("Start date", formatDate(election.start_time));
        detail("End date", formatDate(election.end_time));
        detail("Voting closed", formatDate(election.voting_closed_at));
        detail("Scanning closed", formatDate(election.scanning_closed_at));
        detail("Status", election.status || "Pending");
        detail("Archived at", formatDate(election.archived_at));

        // Ballot statistics
        const statusMap = new Map();

        for (const row of data.ballots) {
            statusMap.set(
                String(row.status).toUpperCase(),
                Number(row.total) || 0
            );
        }

        const totalBallots = [...statusMap.values()]
            .reduce((sum, count) => sum + count, 0);

        heading("Ballot Statistics");

        detail("Total ballot records", totalBallots);
        detail("Counted ballots", statusMap.get("COUNTED") || 0);
        detail("Issued ballots", statusMap.get("ISSUED") || 0);
        detail("Pending CAST ballots", statusMap.get("CAST") || 0);
        detail("Void ballots", statusMap.get("VOID") || 0);
        detail("Scan records", data.scannedCount);

        detail(
            "Invalid ballots",
            "Not yet available from verified invalid-ballot data"
        );

        // Vote lookup
        const voteMap = new Map();

        for (const vote of data.votes) {
            const key = `${vote.position_id}:${vote.candidate_id}`;

            voteMap.set(
                key,
                Number(vote.total_votes) || 0
            );
        }

        heading("Positions, Candidates and Results");

        if (!data.positions.length) {
            item("No positions recorded.");
        }

        for (const position of data.positions) {
            ensureSpace(80);

            const maxSelection = Math.max(
                1,
                Number(position.max_selection) || 1
            );

            doc.font("Helvetica-Bold")
                .fontSize(11)
                .fillColor(MAROON)
                .text(safeText(position.title));

            doc.font("Helvetica")
                .fontSize(9)
                .fillColor("#444444")
                .text(`Maximum winners: ${maxSelection}`);

            doc.moveDown(0.4);

            const candidates = data.candidates
                .filter(candidate =>
                    Number(candidate.position_id) ===
                    Number(position.position_id)
                )
                .map(candidate => {
                    const key =
                        `${candidate.position_id}:${candidate.candidate_id}`;

                    return {
                        ...candidate,
                        totalVotes: voteMap.get(key) || 0
                    };
                })
                .sort((a, b) =>
                    b.totalVotes - a.totalVotes ||
                    Number(a.candidate_id) - Number(b.candidate_id)
                );

            if (!candidates.length) {
                item("No candidates recorded.");
                continue;
            }

            const cutoffIndex = Math.min(
                maxSelection,
                candidates.length
            ) - 1;

            const cutoffVotes =
                candidates[cutoffIndex].totalVotes;

            const tieAtCutoff =
                candidates.length > maxSelection &&
                candidates.filter(candidate =>
                    candidate.totalVotes >= cutoffVotes
                ).length > maxSelection;

            candidates.forEach((candidate, index) => {
                let label = "";

                if (
                    tieAtCutoff &&
                    candidate.totalVotes === cutoffVotes
                ) {
                    label = " [TIE - REVIEW REQUIRED]";
                } else if (
                    !tieAtCutoff &&
                    index < maxSelection &&
                    candidate.totalVotes > 0
                ) {
                    label = " [PROVISIONAL WINNER]";
                }

                item(
                    `${candidate.name} | ` +
                    `${candidate.party_list || "Independent"} | ` +
                    `${candidate.totalVotes} vote(s)${label}`
                );
            });

            if (tieAtCutoff) {
                item(
                    "Tie at winner cutoff. Final determination " +
                    "requires the official tie-breaking rules."
                );
            }

            if (candidates.every(c => c.totalVotes === 0)) {
                item("No winner determined because no votes were recorded.");
            }
        }

        heading("Department / Grade Breakdown");

        item(
            "Not yet available. Ballot-to-scope data " +
            "must be verified before including this breakdown."
        );

        heading("Report Notes");

        item(
            "Votes are counted only from saved COUNTED ballots. " +
            "Winner labels are provisional and subject to official " +
            "election rules."
        );

        item(
            "This report does not archive the election " +
            "or send an email."
        );

        doc.end();
    });
}

module.exports = {
    fetchReportData,
    createPdf
};
