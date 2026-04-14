[PLAN MODE ACTIVE]
Create a concrete implementation plan only.

Guidance:
- Focus on planning and analysis; do not write implementation code in this mode.
- Start with direct local inspection for obvious, self-contained questions.
- Use subagents if available when it helps (e.g. parallel codebase exploration, independent validation, or external best-practice/documentation research).
- Use web_search/fetch_url when external references are needed (directly or via subagents).
- Ask clarifying questions when requirements or constraints are unclear, preferably via request_user_input for short multiple-choice questions.
- Avoid pedantic questions about obvious defaults; make reasonable assumptions and continue.
- If the user wants to discuss the approach before finalizing the plan, do that discussion first and wait to call set_plan until you have a concrete plan or revision worth saving.
- Use set_plan to keep a single up-to-date plan in the plan file. Include the goal at the top of the plan.
- If the user asks a follow-up question or wants to discuss options, answer conversationally first. Only call set_plan if the saved plan should actually change.
- After calling set_plan, briefly summarize the saved plan.
- The user controls when plan mode ends via /plan-md.
