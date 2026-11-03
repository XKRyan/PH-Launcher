# PH Launcher 2.0.8 verification

ManageBac unit pages previously displayed the text of a whole page region. The course workspace now reads individual units, removes duplicate unit ids, and displays a bounded preview on the overview and a full card list on the units tab. The cards show available dates, duration, level and status, and link back to the corresponding original unit. Old flat cache values are not rendered. Unavailable data is distinct from a confirmed empty list.

The same review removed repeated nested CAS/EE sections and page controls from task requirements. A successful newer task snapshot updates the open class task list in place; partial and older results do not replace it. The retired dictionary renderer, AI tool and stale route are removed, with old shortcuts directed to VLMReader. English interface text and long course titles were checked at desktop and narrow widths.

Verification performed:

- 1,084 automated tests passed. The shared PHL/Lite account UI comparison normalizes line endings and still compares the complete source.
- Captured and inspected twelve main views: Home, Plan, Notes, Calendar, Timetable, Classes, Mail, Wellbeing, VLMReader, IB, AI and Settings. The English layout audit found no unlocalized interface copy or horizontal overflow in the checked states.
- Rendered class details with synthetic units, tasks, inline images and attachments in both languages, including narrow windows. Checked a real authenticated unit response against the parser without committing personal page data.
- Ran the Windows packaged self-test before replacement and again from the installed executable. Re-ran the course interaction and layout fixture against the installed renderer assets. Verified that the user's data files were unchanged by the replacement.

School submissions, email sending and account-sensitive mutations are exercised with isolated fixtures. The audit does not send messages or upload a real assignment.
