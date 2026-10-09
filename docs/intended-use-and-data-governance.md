# ResQ Intended Use and Data Governance

**Status:** Draft for review. Not an approved clinical protocol, regulatory determination, or production authorization.

## 1. Proposed v1 intended use

ResQ v1 is a human-led incident coordination tool for authorized responders and incident coordinators. It records incident details, responder-entered observations, review status, and coordination notes, then produces a traceable draft report. The prototype's rules only match warning signs explicitly selected by a user to a prompt for urgent human review.

The current prototype is not an AI injury detector. It does not inspect video or images, diagnose a condition, determine injury cause or severity, estimate the number of injured people, or make dispatch decisions. Its current catalog is demonstration content and is not clinically validated.

**Intended user:** trained or authorized incident coordinators and responders operating under their organization's procedures. Public-facing or autonomous decision use is not approved by this draft.

**Intended setting:** supervised exercises and product evaluation using synthetic or properly authorized records. Live emergency use is out of scope until all review, validation, security, privacy, and regulatory gates below are completed.

## 2. Permitted and prohibited use

Permitted for the prototype:

- Create, search, update, and close incident records.
- Record unverified people counts, incident mechanisms, and signs reported by a responder.
- Match selected signs against the versioned demonstration catalog and prompt human review.
- Export an incident record with its review history, data-source version, and limitations.

Not permitted:

- Medical diagnosis, injury severity grading, treatment or medication advice, diet advice, or recovery-time estimates.
- Automated cause attribution, rescue prioritization, dispatch, or replacement of a qualified responder or dispatcher.
- Video-based identification of injuries or people, including age, gender, identity, emotion, or other sensitive traits.
- Claims that infrared imagery can see through walls, smoke, or obstructions, or that a visual filter is a thermal sensor.
- Use of prototype outputs as verified clinical labels or as ground truth for model training.

For an active emergency, users must contact local emergency services and follow dispatcher and organizational procedures. A missing or unselected warning sign must never be interpreted as evidence that a person is safe.

## 3. Data inventory and handling

| Data class | Prototype behavior | Proposed governance |
| --- | --- | --- |
| Incident record | Stored in local SQLite, including location, incident mechanism, priority, reported count, note, status, and timestamps | Minimize direct identifiers; define a purpose, access group, retention period, and deletion process before operational use |
| Reported warning signs | Stored with an assessment, rule result, and catalog version | Keep source and confirmation status; distinguish unknown, not checked, absent, and present |
| Video upload | Previewed in the browser; not sent to the API or persisted | Do not collect or store operational video until authorization, notice/consent basis, access, retention, and deletion are approved |
| Camera or thermal feed | Optional, operator-authorized read-only HLS preview from a configured gateway; ResQ does not record or control it | Require documented ownership/authority, secure gateway, access logging, retention controls, and sensor-specific validation |
| Guidance catalog | Versioned JSON imported to SQLite at API startup | Record source URL, version, review owner/date, localization, intended audience, and change history; obtain permission for any content beyond link/reference use |
| Model/training data | None bundled or used | Do not add a dataset until its license, provenance, consent/authority, label definition, population coverage, and permitted uses are reviewed |

The current database is a local prototype store, not a production security boundary. Do not put real patient identifiers, credentials, or sensitive video in it. Before operational use, define encryption, authenticated role-based access, audit logs, backups, incident response, retention/deletion, and secure deployment. Keep camera credentials on a protected server or gateway, never in browser code.

## 4. Dataset acceptance requirements

Any future dataset must have documented provenance and explicit rights for the intended development and deployment use. A public download is not automatically licensed, representative, clinically useful, or suitable for surveillance footage.

Before acceptance, document:

- Dataset owner, source, license/terms, collection purpose, consent or other authority, geographic/jurisdictional constraints, and retention obligations.
- Target population and setting; camera modality, viewpoint, resolution, lighting, occlusion, motion, and relevant environmental conditions.
- Label definitions and uncertainty. Separate observable visual events from responder observations, clinically confirmed outcomes, and inferred causes; never silently treat one as another.
- Annotation qualifications, training, adjudication, disagreement handling, missing-label conventions, and measured inter-rater agreement.
- De-identification/minimization plan, re-identification risk, sensitive attribute handling, and a prohibition on unrelated secondary use.
- Dataset version, transformations, exclusions, class balance, known limitations, and a reproducible audit trail.

Do not split video frames randomly across training and test sets. Keep people, incidents, sites, and relevant time periods separated to reduce leakage, and reserve external sites for independent evaluation.

## 5. Model and rules evaluation gates

No model may influence operations until the intended target and harm analysis are approved by clinical and emergency-response reviewers. Evaluation must be performed against independently established reference labels, not against the model's own output or unverified incident notes.

Before a limited pilot, require:

1. A written model card and data statement describing intended use, excluded use, training data, known failure modes, and operating limits.
2. Prospective thresholds set with qualified reviewers. Report sensitivity/false-negative rate for urgent cases, false-alert rate, positive predictive value at the expected prevalence, calibration, and uncertainty; include confidence intervals.
3. Results broken down across relevant populations, sites, devices, environmental conditions, and injury/event categories, with privacy-preserving sample-size safeguards.
4. Independent external validation and a documented comparison against current human workflow. A model must be allowed to abstain or return “unable to assess.”
5. Human-factors testing confirming users understand that model outputs are suggestions, can correct them, and do not mistake “no alert” for “no injury.”
6. A monitored, non-dispatch shadow phase, a rollback plan, drift/incident monitoring, and a named owner empowered to suspend the feature.

Targets and acceptance criteria must be set before reviewing test results. There is no universal accuracy score that by itself establishes safety or clinical validity.

## 6. Operational controls and accountability

Before any live pilot, assign named owners for clinical content, incident operations, privacy, security, data stewardship, model performance, and user support. Establish:

- Role-based access and least privilege; separate exercise/demo data from live records.
- Audit events for record creation, edits, assessment submission, report export, access, and deletion.
- A retention schedule and tested deletion/backup restoration procedures.
- User training, incident escalation procedures, error reporting, and a clear way to override or correct a record.
- Change control for catalogs, rules, models, thresholds, dependencies, and camera gateways.
- Security and privacy threat assessments, regulatory review for each jurisdiction, and a process to pause operation after a safety or security event.

## 7. Decisions requiring approval

These decisions are intentionally unresolved and must be recorded before expanding beyond supervised prototype evaluation:

1. Which organization, jurisdiction, and authorized user roles will own and operate ResQ?
2. Is v1 strictly an incident log/coordination tool, or is a later research-only video triage model desired? What exact observable event would it detect?
3. Which data may be collected, under what authority, for what duration, and who can access/export it?
4. Who approves clinical wording and local emergency escalation content, and how often will it be reviewed?
5. Which outcomes, sites, and independent reviewers will be used for validation, and what pre-registered acceptance thresholds will apply?
6. What hosting, identity, audit, backup, retention, and regulatory requirements apply to the selected deployment?

## 8. Recommended next actions

1. Review this draft with an emergency-response lead, a qualified clinician, and privacy/security counsel; record changes and approvals.
2. Freeze the v1 boundary as incident coordination unless that review explicitly approves a different intended use.
3. Write the data dictionary and retention/access matrix before adding real records or importing datasets.
4. Run scenario-based usability and workflow tests with synthetic data; record failures and revisions.
5. Start a separate dataset/model feasibility assessment only after intended use and data rights are approved.