# Amazon Hackathon Open Source Mini Challenge Submission

## Project Overview

- **Repository Name**: mcp-confirm-gate
- **Repository URL**: https://github.com/RyanDev1st/mcp-confirm-gate
- **Primary Track Submission**: SettleSight Alexa+ (`products/settlesight`, commit `4af459c`)
- **Contribution / Reference URL**: https://github.com/RyanDev1st/settlesight
- **GitHub Username**: RyanDev1st
- **License**: MIT (Open Source)

---

## Devpost Submission Field Description (120 Words)

mcp-confirm-gate is a zero-dependency, cryptographic human-in-the-loop security library for the official Model Context Protocol (MCP) in Node.js. LLM agents frequently need access to tools that mutate state, such as deleting records or executing financial settlements. Conversational safeguards often fail because models can hallucinate confirmation flags or alter arguments between turns. mcp-confirm-gate enforces a strict two-step protocol: mutating actions halt immediately to issue a cryptographically signed, single-use, time-limited token tied to canonical argument hashes. Replaying tokens, forging tokens, or tampering with parameters triggers immediate rejection. Extracted directly from production needs in our primary Amazon hackathon submission, SettleSight Alexa+, mcp-confirm-gate provides an essential, battle-tested guardrail ensuring autonomous AI agents cannot execute destructive database or financial actions without genuine, verifiable, explicit human confirmation.
