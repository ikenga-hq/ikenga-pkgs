# com.ikenga.sales

Sales for the Ikenga desktop: a pipeline (list and kanban), a forecast and a won-deals view. Your deals are stored in the local `ikenga.db` SQLite database on your computer. There is no account, no hosted service and no Supabase involved.

## First run

A new install has no deals, and every view says so ("No deals yet") instead of showing anything made up. From there you can:

- **New deal**: a form that writes the deal straight to the database. Only a company name is required. Stage defaults to Lead; title, value and expected close date are optional. This works with no AI engine and no chat open.
- **Load sample pipeline**: an opt-in action that adds a small made-up pipeline (eight open deals and three won ones, all with invented companies) so you can see what the views look like. Every sample deal is labelled "Sample", a banner stays on screen while any are loaded, and **Remove sample data** deletes exactly those rows and nothing else. Nothing is loaded unless you press the button.
- **Ask the companion to add it**: hands a "create a deal" request to your active chat session, which can research the company and fill in the rest. This needs an AI engine and an open chat session. When either is missing, the pane says so instead of failing silently.

## Stage enum

The `sales_deals.stage` TEXT column holds lowercase values:

| Stage | Type | Description |
|---|---|---|
| `lead` | open | Unqualified opportunity |
| `qualified` | open | Fit confirmed; demo/scoping in progress |
| `proposal` | open | Proposal or MSA in flight |
| `negotiation` | open | Terms under negotiation |
| `closing` | open | Signed / countersign pending |
| `won` | **terminal** | Deal closed-won |
| `lost` | **terminal** | Deal closed-lost |

The Won view queries `sales_deals WHERE stage = 'won'`. There is no `sales_deals_won` table: won deals are rows on `sales_deals` filtered by stage. A deal with a stage outside this list still shows, as its own group with the raw value as its label.

## Views

| View | URL param | Description |
|---|---|---|
| Pipeline: list | `?view=0` (default) | Deal rows grouped by stage, with a detail pane |
| Pipeline: kanban | `?view=0` + seg toggle | A column per stage; drag a card to move it, "+" adds a deal to that stage |
| Forecast | `?view=1` | Open pipeline, weighted pipeline, commit, value by stage, and expected close by month |
| Won | `?view=2` | Total won, average deal size, win rate and a table of `stage='won'` deals |

### How the forecast is worked out

Every figure is computed from the rows in your table. Nothing is a constant.

- **Open pipeline** is the sum of `value` over open deals.
- **Weighted** is the sum of `value x win_probability`, over the deals that have a win probability. When some deals have none, the pane says how many were counted rather than guessing a probability for the rest.
- **Commit** is the value of closing and negotiation deals with a win probability of 70% or more.
- **Expected close by month** groups open deals by the month of `expected_close_date`. A deal counts at `value x win_probability` when it has a probability and at its full value when it has none. Deals with no expected close date are left out, and when no deal has one the panel reads "Add expected close dates to see a forecast".
- **Win rate** is won deals divided by won plus lost deals. It shows a dash until at least one deal is won or lost.

There is no quarterly target: the app has nowhere to store one.

## Sample data marker

Sample rows are written with `source = 'sample'` (ids `sample-01` to `sample-11`). The app does not use the `extra` column, so there is no JSON in it to extend; `source` is a plain column the app already reads. Removal is one `DELETE ... WHERE source = 'sample'`, so a deal you added yourself is never touched.

## Migration

`0043_sales_domain.sql` adds app-layer columns to `sales_deals`:

```sql
ALTER TABLE sales_deals ADD COLUMN title TEXT;
ALTER TABLE sales_deals ADD COLUMN owner TEXT;
ALTER TABLE sales_deals ADD COLUMN next_action TEXT;
ALTER TABLE sales_deals ADD COLUMN next_action_mode TEXT;   -- confirm | silent | approve
ALTER TABLE sales_deals ADD COLUMN win_probability REAL;
```

There is no stored `age_days`. It is derived from `stage_entered_date` when set, else from `days_in_stage`.

## What needs an AI engine

Adding, moving and removing deals, loading and removing the sample pipeline, and every view work without one. These need an engine and an open chat session:

- "Ask the companion to add it".
- "Approve & run" / "Confirm & run" on a deal's next action. The button only reads "Sent" once the request was accepted, and shows the reason when it was not.

There is no in-app way to mark a deal won or lost yet; use the companion, or set the stage in the database.

## CSS naming

- Kit classes: `.frame*` · `.dense-row--pipeline` · `.ip-split*` · `.split-row*` · `.kb-*` · `.nav-group[data-kind]` · `.atelier-state.is-*` · `.tag` · `.chip` · `.btn*` · `.seg*`
- Domain residue (`.sl-*`): `.sl-forecast-*` · `.sl-kpi-*` · `.sl-funnel-*` · `.sl-month-*` · `.sl-won-*` · `.sl-won-badge` · `.sl-won-amt`

## Workspace tint

`data-workspace="sessions"` gives a warm amber-ochre active nav indicator; it differentiates from `mail` (amber) and `outbound` (red-orange).

## Data sources

Tables declared in `manifest.json` `sqlite.tables`:
- `sales_deals`: the pipeline; app-layer columns added by `0043_sales_domain.sql`
- `sales_activities`: the activity timeline in a deal's detail pane
- `sales_forecasts`, `sales_lead_scores`, `contacts`: declared, but this app does not read them today. The forecast is computed from `sales_deals`.
