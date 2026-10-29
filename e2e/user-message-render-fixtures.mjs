// Synthetic transcript data and seeding for the user-message render/source regression.
// Importing this module does no I/O; the runner owns its temporary agent directory.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const timestamp = "2026-08-23T00:00:00.000Z";
export const ISSUE = "e2e-user-source-issue";
export const PAIR = "e2e-user-source-pair";
export const MEDIA = "e2e-user-source-media";
export const SKILL = "e2e-user-source-skill";
export const LONG = "e2e-user-source-long";

// The reporter's message from #1407 plus markdown, formulae and entities.
export const ISSUE_TEXT = [
  '<TableOperator v-model="columns" :tableId="TABLE_ID_CONST.BUSINESS.${basic.businessModule.toUpperCase()}.Demo" :refresh="queryData" /> 咋更离谱呢，要不就去掉 ${basic.businessModule.toUpperCase()} 不要这个变量，直接拼后面部分',
  "",
  "<user-profile>\nE2E profile body remains visible.\n</user-profile>",
  "",
  "## E2E source heading",
  "",
  "**E2E bold** and _E2E italic_ and `E2E inline code`",
  "",
  '<div class="e2e-raw">E2E html &amp; entities &lt;tag&gt; &#39;quote&#39; &nbsp; end</div>',
  "",
  "Template ${user.name} -> ${pick(item)} and a lone ${ brace",
  "",
  "$$E = mc^2$$ and inline $a^2 + b^2 = c^2$.",
  "",
  "| E2E column | Value |",
  "| --- | --- |",
  "| ${row.id} | <b>raw</b> |",
  "",
  "> E2E quoted line",
  "- E2E list item ${vars}",
].join("\n");
export const PAIR_A = "E2E alpha **alpha bold** stays rendered";
export const PAIR_B = "E2E beta **beta bold** stays rendered";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const IMAGE_BLOCK = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } };
export const MEDIA_TEXT = "E2E image message **bold** text";
const SKILL_BODY = "# E2E skill body\n\nDo the E2E skill thing.";
export const SKILL_TEXT = '<skill name="e2e-skill" location="/tmp/e2e-skill/SKILL.md">\nReferences are relative to /tmp/e2e-skill.\n\n'
  + SKILL_BODY + "\n</skill>\n\nrun E2E skill";
export const SKILL_COMMAND = "/skill:e2e-skill run E2E skill";
// Above the 100,000-character markdown guard: rendered stays click-to-reveal.
export const LONG_TEXT = "E2E long message with **markdown** and ${value}\n\n"
  + "E2E paragraph line with ${template.value} and <b>raw</b> stays plain.\n\n".repeat(1600)
  + "E2E long end";

function message(id, parentId, role, content) {
  return { type: "message", id, parentId, timestamp, message: { role, content } };
}

export function seedUserMessageRenderFixtures(agentDir) {
  const project = join(agentDir, "project");
  const sessionDir = join(agentDir, "sessions", "e2e");
  mkdirSync(project);
  mkdirSync(sessionDir, { recursive: true });
  const originals = new Map();

  function writeSession(id, entries) {
    const header = { type: "session", version: 3, id, timestamp, cwd: project };
    const content = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(join(sessionDir, `2026-08-23T00-00-00-000Z_${id}.jsonl`), content);
    originals.set(id, content.trimEnd().split("\n"));
  }

  writeSession(ISSUE, [
    message("u1", null, "user", ISSUE_TEXT),
    message("a1", "u1", "assistant", "E2E answer to the issue prompt"),
  ]);
  writeSession(PAIR, [
    message("u1", null, "user", PAIR_A),
    message("a1", "u1", "assistant", "E2E alpha reply"),
    message("u2", "a1", "user", PAIR_B),
    message("a2", "u2", "assistant", "E2E beta reply"),
  ]);
  writeSession(MEDIA, [
    message("m1", null, "user", [IMAGE_BLOCK]),
    message("a1", "m1", "assistant", "E2E image-only reply"),
    message("m2", "a1", "user", [{ type: "text", text: MEDIA_TEXT }, IMAGE_BLOCK]),
    message("a2", "m2", "assistant", "E2E image-text reply"),
  ]);
  writeSession(SKILL, [
    message("s1", null, "user", SKILL_TEXT),
    message("a1", "s1", "assistant", "E2E skill reply"),
  ]);
  writeSession(LONG, [
    message("l1", null, "user", LONG_TEXT),
    message("a1", "l1", "assistant", "E2E long reply"),
  ]);
  return { sessionDir, originals };
}
