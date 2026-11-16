# MUG Sample City Autumn Summit (fictional)

Date: a fictional Saturday in October, 10:00 to 17:00.
Host: Cogwheel & Marmalade Ltd. (fictional), the Kettle Room on the ground floor, capacity 120.

The autumn summit is the longest event of the fictional year: a keynote in the morning, a hands-on
workshop after lunch, and an open floor for lightning talks at the end of the day. Doors open at 09:30
with coffee and pastries. Lunch is served from 12:30 to 13:30 in the atrium next to the Kettle Room.
Attendance is free, but registration closes three days before the event, because the host prints
visitor badges in advance and cannot add names on the day. The summit is recorded, except for the
lightning talks, which stay off the record so that first-time speakers feel free to try out an idea.
Volunteers arrive at 08:45 to set up chairs, the registration desk and the signage from the bus stop.

## Keynote: Schema Validation as a Safety Net

Wendeline Gooseberry opens the summit with a keynote on schema validation in MongoDB. Flexible documents
are a strength until a single bad writer stores a price as a string and a nightly report quietly sums
nothing. The keynote walks through attaching a `$jsonSchema` validator to an existing collection with
`collMod`, starting with `validationAction: "warn"` so that violations are logged instead of rejected,
reading the log for a week to find every writer that breaks the rules, and only then switching to
`validationAction: "error"`. Wendeline shows how `validationLevel: "moderate"` lets old documents that
predate the rules be updated without failing, how `required`, `bsonType` and `enum` catch the common
mistakes, and why `bypassDocumentValidation` should be reserved for a migration script that has its own
tests. The closing section covers keeping the validator in version control next to the application
code, so that a schema change is reviewed like any other change.

## Workshop: Aggregation Pipelines from Scratch

After lunch Ignatius Fogwhistle runs a two-hour workshop on the aggregation framework. Everyone works on
the same small dataset: a fictional volunteer sign-up sheet with names replaced by numbers, shift
times and the tasks people chose. The workshop builds one pipeline stage at a time: `$match` to keep
one month, `$group` to count shifts per task, `$lookup` to join the task descriptions, `$unwind` to
flatten an array of chosen tasks, and `$facet` to produce a summary and a detailed breakdown from a
single pass. The last exercise uses `$setWindowFields` to compute a running total of shifts per week.
Laptops are required; the dataset and the exercises are shared on a USB stick at the door, so nobody
needs to download anything over the venue network. Helpers walk the room to unblock anyone stuck.

## Logistics and accessibility

The Kettle Room has step-free access from the side entrance on the fictional Bramble Lane, and a
lift serves the atrium. A quiet room on the ground floor stays open all day for anyone who needs a
break from the crowd. Live captions are projected next to the slides during the keynote and the
workshop introduction. The cloakroom closes at 17:15, and anything left behind goes to the lost
property box at reception for a week. There is covered bike parking for thirty bikes behind the
building. Dietary needs collected at registration are passed to the caterer, and every dish is
labelled with its allergens.
