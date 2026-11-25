# OmniRoute Usage

A Herdr view of provider quota reported by one OmniRoute instance.

## Language

**OmniRoute instance**:
The single OmniRoute deployment that supplies provider account and quota information to the mod.

**Provider account**:
An individual account connected to the OmniRoute instance for a particular provider. One provider can have multiple accounts.

**Remaining quota**:
The allowance a provider account still has available under a provider-reported limit. It is distinct from historical token usage.

**Provider summary**:
A view of remaining quota across the configured accounts of one provider. It combines only comparable quota windows and does not replace the individual account values.

**Quota window**:
A provider-defined period with its own allowance and natural reset. An account may have more than one quota window, such as Codex’s 5-hour and weekly windows.

**Mixed remaining average**:
The average of the Codex 5-hour and weekly remaining summaries. The two windows contribute equally to Mixed; within each window, accounts with known relative allowances contribute in proportion to those allowances. Mixed is not a pooled allowance or a measure of routing eligibility.

**Natural reset**:
The scheduled replenishment of a quota window without spending a banked reset.

**Banked reset**:
A provider-issued, expiring credit tied to an account that can be redeemed through OmniRoute to reset eligible quota early.
