// Text a user chose, such as an export ban list's name or a Steam name, as it goes in a line for
// the log channel: on one line, and shown in Discord as it was written.
//
// - Each run of line breaks, other spaces, control characters and characters that change the
//   direction of the text (Bidi_Control) becomes one space. So the text cannot start a line of its
//   own, such as one that looks like another module's or another user's, or make the rest of its
//   line read differently.
// - The characters Discord reads as Markdown within a line get a backslash before them. So the
//   text cannot hide the rest of the line in a spoiler, become a masked link or a mention, or lose
//   its underscores to italics. Markdown that only works at the start of a line, such as a quote or
//   a heading, is left alone, as this text never starts one.
//
// The console shows the backslashes.
//
// This file has no imports, so it can be loaded on its own.
const BREAKS = /[\s\p{Cc}\p{Bidi_Control}]+/gu;
const MARKDOWN = /[\\*_~`|[\]<]/g;

export default function logText(value) {
  return String(value).replace(BREAKS, ' ').replace(MARKDOWN, '\\$&');
}
