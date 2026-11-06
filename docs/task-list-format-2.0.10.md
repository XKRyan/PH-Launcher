# Task requirement list formatting (2.0.10)

Task and calendar-event descriptions previously flattened HTML list items into
plain text. Browser-generated numbering disappeared even though the item text
and images survived.

The parser now retains ordered and unordered lists, nesting, custom start and
item values, reverse numbering and alphabetic/Roman marker types as inert data.
The renderer creates native list elements and keeps images within their owning
items. Source HTML and event handlers are never injected into the application.
Existing text/image blocks remain compatible. Previously cached descriptions
receive the richer structure on the next successful school refresh.

Validation performed:

- Full automated suite: 1088 passed, zero failures.
- Parser regressions cover task lists with interspersed images and nested
  bullet lists, plus calendar lists with custom/reversed numbering.
- Real Electron rendering checks cover three visible numbered items, nested
  bullets, image decoding, numbering attributes and horizontal overflow in
  English and Chinese at regular and compact window sizes.
- Packaged application self-test and rendering checks passed.
- After replacing the local program, the installed application self-test and
  rendering checks passed again. The replacement utility verified that personal
  data files were unchanged during installation.

Rendering checks use synthetic school content and do not submit school work or
retry credentials.
