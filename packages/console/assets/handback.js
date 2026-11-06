/* global document */
// The team hand-back (ADR 722 §1): send the signed statement on to the team as soon as the page
// loads. The page's own Continue button does the same for a browser that runs no script.
document.addEventListener('DOMContentLoaded', () => {
  const form = document.forms[0];
  if (form) form.submit();
});
