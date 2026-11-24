# Rule validation against the model's own verdicts

467 stored messages; the model called **262** of them newsletter_or_noise. 467 have had their List-Unsubscribe header and calendar part read; 0 have not (the header rules cannot judge those).

## The model-noise messages, by what the rules say

| Rules say | Messages | Share |
| --- | ---: | ---: |
| noise (agrees) | 28 | 11% |
| something else (disagrees) | 7 | 3% |
| no rule matched (only the model knows) | 227 | 87% |
| not judged (structure never read) | 0 | 0% |

Of the agreeing ones, 28 are caught by List-Unsubscribe alone.

## Would a sender-based rule have caught them?

A sender rule ("everything from this address is noise") is safe only for a sender whose mail the model called noise EVERY time. 204 of the 262 model-noise messages come from such senders; 58 come from senders that also sent something the model called otherwise, where a sender rule would misfire.

| Sender | Messages | Model noise | A rule also says noise | Sender rule safe? | Always List-Unsubscribe? | Other intents from this sender |
| --- | ---: | ---: | ---: | --- | --- | --- |
| info@meetup.com | 196 | 196 | 0 | yes | no | - |
| notification@slack.com | 35 | 21 | 0 | **no** | no | other 6, sponsor_enquiry 1, attendee_question 2, speaker_reply 3 |
| community-noreply@mongodb.com | 32 | 14 | 14 | **no** | yes | other 16, speaker_reply 1 |
| veronica.cooley-perry@mongodb.com | 13 | 5 | 0 | **no** | no | other 8 |
| notifications@monday.com | 27 | 4 | 0 | **no** | no | speaker_reply 4, attendee_question 2, other 13, venue_reply 2, sponsor_enquiry 2 |
| linkedin@em.linkedin.com | 5 | 4 | 4 | **no** | yes | other 1 |
| customerservice@kotisdesign.com | 14 | 3 | 0 | **no** | no | speaker_reply 1, other 10 |
| mug-lisbon@calendar.luma-mail.com | 12 | 3 | 0 | **no** | no | other 7, venue_reply 2 |
| info@email.meetup.com | 6 | 3 | 3 | **no** | yes | other 3 |
| jobalerts-noreply@linkedin.com | 3 | 3 | 3 | yes | yes | - |
| meetup-group-bgcytlbx-announce@email.meetup.com | 1 | 1 | 1 | yes | yes | - |
| noreply-community@mongodb.com | 1 | 1 | 0 | yes | no | - |
| edidiong.asikpo@mongodb.com | 3 | 1 | 0 | **no** | no | speaker_reply 1, other 1 |
| google-developer-group-lisboa-announce@email.meetup.com | 1 | 1 | 1 | yes | yes | - |
| messages-noreply@linkedin.com | 1 | 1 | 1 | yes | yes | - |
| invitations@linkedin.com | 1 | 1 | 1 | yes | yes | - |

## Per rule: matched, and agreed with the model

| Rule | Matched | Model agreed | Model disagreed |
| --- | ---: | ---: | ---: |
| rule_calendar | 42 | 0 | 42 |
| rule_sender_list | 5 | 0 | 5 |
| rule_list_unsubscribe | 49 | 28 | 21 |

## Every disagreement (68)

Neither side is preferred: each row is a message where a rule and the model gave different intents. Decide which was right.

| Date | Sender | Subject | Model | Rule | Rule says |
| --- | --- | --- | --- | --- | --- |
| 2025-07-21 | info@meetup.com | See you at: MongoDB User Group Lisbon: 29/07/2025 First Lisbon Event | newsletter_or_noise | rule_calendar | calendar_invite |
| 2026-06-25 | joao.mourao@mongodb.com | Invitation: MUG & AWS UG: Sync @ Fri Jun 26, 2026 11am - 11:30am (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-03-02 | joao.mourao@mongodb.com | Invitation: Meetup @ Mon Mar 2, 2026 3:30pm - 3:45pm (WET) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-05-07 | joao.mourao@mongodb.com | Tentatively Accepted: Creation the MUG event instructions @ Thu May 7, 2026 11:30am - 12:30pm (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-03-06 | drive-shares-dm-noreply@google.com | Folder shared with you: "MongoDBxGDG" | other | rule_sender_list | document_share |
| 2026-04-08 | joao.mourao@mongodb.com | Accepted: Meeting with Joao @ Thu Apr 9, 2026 2pm - 2:30pm (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-04-13 | joao.mourao@mongodb.com | Accepted: Vlada & Joao @ Tue Apr 14, 2026 12:15pm - 12:45pm (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-04-14 | joao.mourao@mongodb.com | Invitation: cloudFlare & MUG Lisbon @ Fri Apr 17, 2026 12pm - 1pm (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-04-09 | joao.mourao@mongodb.com | Accepted: Vlada & Joao @ Tue Apr 14, 2026 11am - 12pm (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-04-13 | joao.mourao@mongodb.com | Accepted: Vlada & Joao @ Tue Apr 14, 2026 11:15am - 11:45am (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-02-17 | veronica.cooley-perry@mongodb.com | Invitation from an unknown sender: MUG Lisbon Connect @ Thu Feb 26, 2026 2pm - 2:30pm (WET) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2025-10-08 | joao.mourao@mongodb.com | Invitation from an unknown sender: Vladyslava & Joao Mug Sync @ Fri Oct 10, 2025 10am - 10:30am (GMT+1) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-01-08 | yashraj.nayak@mongodb.com | Invitation: MUG Lisbon Sync-up @ Every 6 weeks from 8:30am to 9am on Friday (WET) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-01-08 | yashraj.nayak@mongodb.com | Updated invitation: MUG Lisbon Sync-up @ Fri Jan 9, 2026 10am - 10:30am (WET) (vladyslava.prykhodko@gmail.com) | venue_reply | rule_calendar | calendar_invite |
| 2025-10-17 | joao.mourao@mongodb.com | Invitation: MUG Lisboa Sync @ Sat Oct 25, 2025 3pm - 3:30pm (GMT+1) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2025-10-18 | drive-shares-dm-noreply@google.com | Folder shared with you: "MongoDB User Group Lisbon Assets" | other | rule_sender_list | document_share |
| 2025-10-17 | joao.mourao@mongodb.com | Updated invitation: MUG Lisboa Sync @ Sat Oct 18, 2025 3pm - 3:30pm (GMT+1) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-11-05 | drive-shares-noreply@google.com | You’ve been added to the shared drive MUG Lisbon | other | rule_sender_list | document_share |
| 2026-10-22 | mug-lisbon@calendar.luma-mail.com | Update for MUG Lisbon x JUG Lisbon NOV 2026 - Java & MongoDB: Before and After the AI Hype | other | rule_calendar | calendar_invite |
| 2026-10-22 | mug-lisbon@calendar.luma-mail.com | Update for MUG Lisbon x JUG Lisbon NOV 2026 - Java & MongoDB: Before and After the AI Hype | other | rule_calendar | calendar_invite |
| 2026-10-16 | info@meetup.com | You've scheduled: MongoDB User Group Lisbon × Java User Group Lisbon at Critical Software | newsletter_or_noise | rule_calendar | calendar_invite |
| 2026-10-22 | mug-lisbon@calendar.luma-mail.com | Update for MUG Lisbon x Java User Group Lisbon NOV 2026 - Java & MongoDB: Before and After the AI Hype | other | rule_calendar | calendar_invite |
| 2026-10-22 | mug-lisbon@calendar.luma-mail.com | Update for MUG Lisbon x Java User Group Lisbon NOV 2026 - Java & MongoDB: Before and After the AI Hype | other | rule_calendar | calendar_invite |
| 2026-10-22 | mug-lisbon@calendar.luma-mail.com | Update for MUG Lisbon x Java User Group Lisbon NOV 2026 - Java vs. The Agent Engine | other | rule_calendar | calendar_invite |
| 2026-10-22 | mug-lisbon@calendar.luma-mail.com | Update for MUG Lisbon x Java User Group Lisbon NOV 2026 - Java vs. The Agent Engine | newsletter_or_noise | rule_calendar | calendar_invite |
| 2026-10-21 | mug-lisbon@calendar.luma-mail.com | Update for MongoDB User Group Lisbon × Java User Group Lisbon at Critical Software | other | rule_calendar | calendar_invite |
| 2026-10-21 | mug-lisbon@calendar.luma-mail.com | Update for MongoDB User Group Lisbon × Java User Group Lisbon at Critical Software | venue_reply | rule_calendar | calendar_invite |
| 2026-10-21 | mug-lisbon@calendar.luma-mail.com | Registration confirmed for MUG Lisbon NOV 2026 - Java vs. The Agent Engine | venue_reply | rule_calendar | calendar_invite |
| 2026-10-20 | mug-lisbon@calendar.luma-mail.com | Update for MUG Lisbon NOV 2026 - Java vs. The Agent Engine | other | rule_calendar | calendar_invite |
| 2026-10-14 | mongodb@user.luma-mail.com | Please join me as a host for MUG Lisbon NOV 2026 - Title of session | other | rule_calendar | calendar_invite |
| 2026-08-07 | sil.cleary@mongodb.com | Invitation: MUG Intro - EMEA Region @ Tue Aug 18, 2026 5pm - 6pm (WEST) (vladyslava.prykhodko@gmail.com) | speaker_reply | rule_calendar | calendar_invite |
| 2026-07-16 | info@meetup.com | See you at: AWS Meets MongoDB - AWS UG & MongoDB | newsletter_or_noise | rule_calendar | calendar_invite |
| 2026-06-04 | drive-shares-dm-noreply@google.com | Presentation shared with you: "mug-cloudflare-lisbon-june-2026.pptx" | speaker_reply | rule_sender_list | document_share |
| 2026-05-11 | info@meetup.com | You've scheduled: MongoDB User Group Lisbon (MUG) @ Cloudflare | newsletter_or_noise | rule_calendar | calendar_invite |
| 2026-05-11 | info@email.meetup.com | 📅 Just scheduled: MongoDB User Group Lisbon (MUG) @ Cloudflare | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-05-06 | veronica.cooley-perry@mongodb.com | Invitation:  Community Advocate Workshop - Aggregation Framework with... @ Thu May 14, 2026 6pm - 8pm (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-04-27 | appel.professional@gmail.com | Invitation from an unknown sender: Community Joint event MUG + JUG @ Wed Apr 29, 2026 11:30am - 11:45am (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-04-15 | drive-shares-dm-noreply@google.com | Folder shared with you: "Lisbon MUG" | other | rule_sender_list | document_share |
| 2026-04-16 | joao.mourao@mongodb.com | Canceled event with note: cloudFlare & MUG Lisbon @ Fri Apr 17, 2026 12pm - 1pm (WEST) (vladyslava.prykhodko@gmail.com) | venue_reply | rule_calendar | calendar_invite |
| 2026-04-10 | lurdeskasisa@gmail.com | Accepted: Lurdes & Vlada MUG @ Fri Apr 10, 2026 11:30am - 12pm (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-03-25 | veronica.cooley-perry@mongodb.com | Invitation: Option 1: MUG Leader Connect @ Wed Apr 8, 2026 6pm - 6:45pm (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-03-25 | veronica.cooley-perry@mongodb.com | Invitation: Option 3: MUG Leader Connect @ Thu Apr 9, 2026 12pm - 12:45pm (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-03-25 | veronica.cooley-perry@mongodb.com | Invitation: Option 2: MUG Leader Connect @ Thu Apr 9, 2026 12am - 12:45am (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-03-25 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] MongoDB Meetup: Retrieval-Augmented Generation Skill Badge Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-30 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] MUG Thailand Meetup #06: THMUG x PyLanna Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-04-03 | veronica.cooley-perry@mongodb.com | Invitation: Community Advocate Workshop - CRUD Operations for Java De... @ Wed Apr 22, 2026 3pm - 5pm (WEST) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-03-22 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] MongoDB Momentum: From Schemas to Supremacy Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-21 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] MongoDB and AI Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-21 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] MongoDB and AI Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-23 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] Montreal MUG: Indexing with MongoDB Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-23 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] Montreal MUG: Indexing with MongoDB Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-12 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] MUG Chandigarh - Innovate with Data Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-16 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] AI Agents with MongoDB Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-13 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] MUG Florianópolis & Ponta Grossa Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-13 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] MUG Florianópolis & Ponta Grossa Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-09 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] MUG <> GitTogether Meetup: AI Dev Tools Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-12 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] MUG Lille #1 Adeo Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-07 | info@meetup.com | You're now an Event Host for: MongoDB User Group Lisbon (MUG) x GDG Lisbon @ Devoteam Creative Tech | newsletter_or_noise | rule_calendar | calendar_invite |
| 2026-03-07 | info@email.meetup.com | 📅 Just scheduled: MongoDB User Group Lisbon (MUG) x GDG Lisbon @ Devoteam Creative Tech | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-02 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] #18 MUG@KL Meetup Retrospective | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-03 | community-noreply@mongodb.com | [MongoDB Community Hub] [Community Programs/User Group Leaders] Nairobi MUG Retrospective: 21st Feb 2026 Event | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-02-23 | community-noreply@mongodb.com | [MongoDB Community Hub] [PM] Event Support Needed by Vladyslava Prykhodko - Av. Dom João II 43, 1990-084 Lisboa | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-03-02 | info@email.meetup.com | 📅 Just scheduled: MongoDB User Group Lisbon (MUG) x GDG Lisbon @ Devoteam Creative Tech | other | rule_list_unsubscribe | newsletter_or_noise |
| 2026-02-27 | info@meetup.com | You've scheduled: MongoDB User Group Lisbon (MUG) x GDG Lisbon @ Devoteam Creative Tech | newsletter_or_noise | rule_calendar | calendar_invite |
| 2026-02-12 | veronica.cooley-perry@mongodb.com | Invitation from an unknown sender: Community Advocate Workshop - CRUD Operations for Python ... @ Thu Feb 26, 2026 3pm - 5pm (WET) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2025-12-31 | community-noreply@mongodb.com | [MongoDB Community Hub] [PM] New MUG Leader Application (Lisbon, Portugal): Vladyslava Prykhodko | speaker_reply | rule_list_unsubscribe | newsletter_or_noise |
| 2025-12-31 | yashraj.nayak@mongodb.com | Invitation from an unknown sender: ✨ MUG Leader Onboarding - Vladyslava @ Fri Jan 2, 2026 10am - 10:30am (WET) (vladyslava.prykhodko@gmail.com) | other | rule_calendar | calendar_invite |
| 2026-11-18 | linkedin@em.linkedin.com | Your Page has been mentioned! | other | rule_list_unsubscribe | newsletter_or_noise |

3 messages were left out of the comparison because their stored verdict was itself a rule or a lookup.
