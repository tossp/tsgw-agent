// Feed complete SSE messages incrementally: network chunks and PTY events may
// split anywhere, so assertions must inspect reconstructed output.data, not
// adjacent bytes in the JSON wire representation.
export function createTerminalOutput() {
  let pending = "";
  let output = "";
  return (chunk) => {
    pending = (pending + chunk).replaceAll("\r\n", "\n");
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) !== -1) {
      const message = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = message.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      const event = JSON.parse(data);
      if (event.type === "output" && typeof event.data === "string") output += event.data;
    }
    return output;
  };
}
