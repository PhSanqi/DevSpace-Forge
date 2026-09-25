# Control Console — style exploration

Target: the local-only DevSpace Control Console, used by a technical operator to
manage a single machine and diagnose its public MCP connection.

Three materially different directions were considered:

1. **Dense NOC.** Telemetry-first wall of tables, compact typography, minimal
   spacing, live indicators everywhere. Efficient for continuous monitoring but
   makes infrequent, consequential configuration and rollback actions harder to
   find and increases apparent conflicts between status and control.
2. **Editorial product dashboard.** Large hero, spacious feature cards, strong
   visual storytelling and generous motion. Clear first impression but wastes
   space on a functional management surface and risks hiding the actual process
   identity and operational controls.
3. **Task-owned operator console (selected).** Quiet technical hierarchy,
   restrained blue accent, explicit task navigation, compact evidence panels,
   and local action/confirmation placement. It separates what is running from
   what is configured and gives every credential, setting and operation one
   canonical location.

Selection criterion: remove conflicting content without sacrificing Windows
manager parity, evidence quality or operational safety. This is not a second
frontend framework or a new backend architecture.
