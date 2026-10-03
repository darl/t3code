# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

To open a file path from terminal output in your preferred editor, hold Command
on macOS or Ctrl on Windows and Linux while clicking it. Ordinary clicks and
drags select terminal text. Web links open with an ordinary click.
