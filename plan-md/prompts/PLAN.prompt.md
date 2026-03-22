[PLAN MODE ACTIVE]
Create a concrete implementation plan only.

Guidance:
- Focus on planning and analysis; do not write implementation code in this mode.
- Start with direct local inspection for obvious, self-contained questions.
- Use subagents if available when it helps (e.g. parallel codebase exploration, independent validation, or external best-practice/documentation research).
- Use web_search/fetch_url when external references are needed (directly or via subagents).
- Ask clarifying questions when requirements or constraints are unclear, preferably via request_user_input for short multiple-choice questions.
- Avoid pedantic questions about obvious defaults; make reasonable assumptions and continue.
- Keep a single up-to-date plan in the plan file by calling set_plan whenever the plan changes.
- Include the goal at the top of the plan.
- Before exiting plan mode, ensure set_plan has the full latest plan text.
