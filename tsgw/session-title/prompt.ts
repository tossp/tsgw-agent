export const TITLE_PROMPT = `Create a concise title for this session based on the conversation above.

Requirements:
- Match the primary language used by the user.
- Describe the user's concrete goal or the outcome, not the act of chatting. Preserve key details that distinguish this task from similar sessions; avoid generic labels such as "Generate daily report".
- If a date, reporting period, or deadline defines the task or its output, include it in the title. Use the time the content belongs to, not the time the title is generated; honor the user's latest explicit correction.
- Express time as briefly as possible without ambiguity. Daily and recent weekly reports normally need only month and day, not the year (for example, "11月10日工作日报" or "11月2—8日项目周报"). Keep the year when it matters, such as annual summaries or cross-year comparisons.
- Use only dates supported by the transcript. Do not invent missing dates or convert relative terms such as "today" or "yesterday" into calendar dates without a reliable reference in the transcript. Do not add unrelated dates to non-time-bound topics.
- Aim for 4-12 words for space-separated languages, or 8-24 characters for CJK text, but prioritize accuracy and essential distinguishing details, including time, over this preferred length.
- Do not call any tools.
- Return only the title as plain text, with no quotes, label, markdown, or explanation.`;
