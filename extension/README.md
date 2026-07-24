# Berlin Lost & Found Form Helper

This optional Manifest V3 browser extension fills a reviewed field package after
the traveller explicitly pastes it into the extension popup.

Safety rules:

- it only runs on the active tab after the traveller clicks the extension;
- the package origin must exactly match the active website;
- packages expire after two hours;
- consent, checkbox and file fields are never filled;
- required consent, file and other manual fields are checked before submission;
- experimental adapters are excluded from the built extension;
- without a separately reviewed, hash-matched adapter it never shows a submit
  action;
- with such an adapter, submission still requires a second click and an
  in-page confirmation, checks the filled values again, clicks once, and only
  records success when the official page shows the reviewed success state;
- after a confirmed or uncertain attempt, it can copy a result package back to
  the matching report card. The app checks the exact report fingerprint before
  recording the result or receipt.

Load the `extension/` directory as an unpacked extension during development.
