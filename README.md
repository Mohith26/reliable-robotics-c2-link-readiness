# C2 Link Readiness (concept for Reliable Robotics)

**Live demo:** https://mohith26.github.io/reliable-robotics-c2-link-readiness/

A flight-test analysis report that turns C-Band CNPC packet logs into a calibrated readiness verdict for each approach:
*will this approach meet the derived link-continuity requirement on a typical day after the radio software update, how
likely is a single run to drop traffic off the remote pilot display for 3 s or more, and how many more characterization
runs would settle it?* It is styled after the flight-test reports in Reliable's public FAA BAA #005 final report.

Unofficial concept demo by Mohith Gajjela. Not affiliated with Reliable Robotics. **All packet data is synthetic.**

## Why

Reliable's GBDAA final report (FAA BAA Call #005, Sept 2025) found that C-Band CNPC continuity averaged 91.6% against a
derived 98.2% requirement, that dropouts recur in the same places on the RNAV 13 approach and do not line up with
obstructions, and that the improvement after the Aug 14 uAvionix update was "not conclusive as the flown routes after Aug 14th
do not include RNAV 13." It recommends link characterization as part of every C-Band installation.

That last sentence is a statistics problem. A per-day bar chart mixes three things: *where* the aircraft flew, *which day* it
was (Aug 14 was far worse for unknown reasons), and *which radio software* was running. This tool separates them and says
how sure it is.

## What it does

* **Outage detection.** Runs of 2 or more lost packets (1 s or more at 2 packets/s) are outages; runs split by a single
  received packet are merged. Isolated single losses are modeled separately.
* **Onset model.** Outage onsets per 900 m cell and test day are Poisson with log-rate
  `b0 + bR*log(range) + delta*postUpdate + gamma_day + s_cell`:
  * `s_cell` is a Gaussian Markov random field (4-neighbour graph Laplacian), so dropout regions are learned from the logs and
    shared with neighbouring cells, including cells on approaches that were never flown;
  * `gamma_day` is Student-t (3 dof), so one anomalous day (Aug 14 here) is flagged and down-weighted instead of inflating
    the spread assumed for every future day;
  * `delta` is the update effect, identified only from cells flown in both software eras.
* **Fit.** MAP by Newton's method, Laplace posterior, spatial precision and day spread chosen by Laplace marginal likelihood
  over a grid (with a weak half-normal hyper-prior on the day spread, since 8 days barely identify it).
* **Prediction.** 400 posterior draws give a typical-day continuity interval per approach (renewal approximation for the
  expected outage time), and Gilbert-Elliott Monte Carlo runs with Student-t day effects give single-run probabilities, such
  as P(longest outage of 3 s or more). Verdict: Ready if P(meets) is 90% or more, Not ready if 10% or less, otherwise
  Inconclusive.
* **Characterization plan.** Pre-posterior analysis: add the expected Fisher information of N more post-update runs (one per
  new day, each day's effect integrated out) and recompute the interval with common random numbers. Reports how many runs
  would make the verdict decisive.
* **Terrain check.** ITU-R P.526 knife-edge diffraction from the ground station to every point on every final, using real
  terrain (AWS Terrain Tiles). All four finals are line-of-sight clear, which is why the dropout field has to be learned
  from logs rather than from a propagation model.
* **Backtest.** Leave-one-day-out 90% predictive intervals for every flown run.

## Result on the demo data (synthetic)

| | |
|---|---|
| Observed continuity, mean of days / final three days | 91.6% / 98.7% (the generator was tuned to resemble the public report's 91.6% / 98.2%) |
| Update effect on dropout rate | 0.32x (90% CI 0.18 to 0.54); a naive before/after says 0.11x |
| RNAV 13, post-update, typical day | 96.9% (95.4% to 97.9%): **Not ready** against 98.2%, even though it was never flown after the update |
| RNAV 06 | 99.1% (98.6% to 99.4%): Ready |
| RNAV 31 | 98.5% (97.8% to 99.0%): Inconclusive; still inconclusive after 8 more runs because it sits 0.3 points from the requirement |
| RNAV 24 (notional, never flown) | 99.0% (97.5% to 99.4%): Inconclusive; one more run is expected to settle it |
| Backtest | 44/51 runs inside their 90% interval; 44/46 excluding the flagged anomalous day |

Against the simulator's ground truth, over 10 independent synthetic campaigns: 37/40 approach intervals covered the true
typical-day continuity, the update-effect interval covered the true effect 10/10 times, and none of the 40 verdicts was
wrong (28 were decisive).

## Run it

```
python3 -m http.server   # then open http://localhost:8000
npm test                 # node --test test/readiness.test.mjs (10 tests)
node scripts/generate.mjs   # regenerate data/campaign.json (seeded, deterministic)
node scripts/terrain.mjs    # rebuild data/terrain.json from AWS Terrain Tiles
```

No build step and no dependencies. `core/` is plain ES modules shared by the page and the tests.

## Tests

`test/readiness.test.mjs`: Cholesky/solve/log-det against hand values; outage extraction on a hand-built packet stream;
closed-form continuity vs Monte Carlo; ITU knife-edge values and line-of-sight finals on the shipped terrain; shipped data
reproducible from the seed; MAP stationarity by finite differences and down-weighting of the anomalous day; update-effect
interval covers the truth and the naive ratio falls outside it; typical-day intervals cover the simulated truth; plan
intervals never widen with more runs; calibration of 80% or better across 5 independent campaigns.

## Honest limitations

* **Synthetic data.** The schedule mirrors the public report (8 days, RNAV 13 only before the update), and the aggregates
  were tuned to resemble it, but every dropout location and magnitude is invented. Approach geometry is approximate
  (straight-in finals on true runway headings), not charted procedures. RNAV 24 is notional.
* **Assumes a uniform update effect.** A post-update prediction for cells that were only flown before the update assumes
  the update changed every location by the same factor. The model can check this only where both eras overlap.
* **Single ground station, uplink only, 2 packets/s.** Switchover, downlink, latency and multi-link (Satcom/LTE) availability
  are out of scope; the real requirement is derived from the combined link availability in DO-362A.
* **Pre-posterior plans assume the estimate does not move.** They tell you how much data would settle the question if the
  current estimate is right, not what the answer will be.
* **Day-to-day variation is estimated from 8 days.** With so few days its spread is weakly identified, so single-run
  probabilities are rougher than the typical-day intervals.

## Novelty note

RF propagation and viewshed coverage prediction for C2 links exists (for example uAvionix's FAA BAA #004 frequency-assignment
work), and a 2022 patent (US 11,423,789) describes alerting when a planned route exceeds modeled C2 link coverage. I did not find
a public tool, in Reliable's materials or elsewhere, that estimates per-approach continuity *from flight-test packet logs* with
calibrated uncertainty, models bursty outages, separates a mid-campaign software update from the route mix and from anomalous
days, and plans the characterization runs needed to reach a decision. If Reliable already has this internally, this is an
outside take on the same problem.
