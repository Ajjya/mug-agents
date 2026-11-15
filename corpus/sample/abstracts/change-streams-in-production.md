# Change Streams in Production

Speaker: Zara Quillfeather, Bluepenguin Logistics (fictional)

Change streams let an application react to inserts, updates and deletes as they happen, without polling. This talk walks through running change streams in production for eighteen months at a fictional parcel tracker: how we store resume tokens so a restarted consumer picks up exactly where it stopped, why we pre-filter events with an aggregation pipeline, and what happened when the oplog window was shorter than our longest outage.

## What you will take away

How to size the oplog window, when to use fullDocument lookups, and how to test a consumer that must never miss an event.
