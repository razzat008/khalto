import numpy as np
from typing import Optional

class MCMCChangePointDetector:
    """
    Metropolis-Hastings sampler to detect if a sequence of confidence scores
    has a structural change point.
    
    A genuine pothole cluster shows: low confidence reports early (rough road noise),
    rising confidence as more vehicles confirm the exact location.
    Random noise shows: uniform low confidence with no upward regime shift.
    """

    def __init__(self, n_samples: int = 1500, burn_in: int = 300):
        self.n_samples = n_samples
        self.burn_in = burn_in

    def log_prior(self, tau: int, N: int) -> float:
        """Beta(2,2) prior on the change-point location to prevent edge effects."""
        if tau <= 1 or tau >= N - 1:
            return -np.inf
        x = tau / N
        return float(np.log(x) + np.log(1.0 - x))

    def log_likelihood(self, sequence: np.ndarray, tau: int) -> float:
        """
        Log-likelihood of the sequence given a change-point at index tau,
        modeling each segment as a Normal distribution with its own estimated variance.
        """
        if tau <= 1 or tau >= len(sequence) - 1:
            return -np.inf

        pre = sequence[:tau]
        post = sequence[tau:]

        mu_pre = np.mean(pre)
        mu_post = np.mean(post)

        # Estimate variance dynamically with a minimum floor to avoid divide-by-zero
        var_pre = max(float(np.var(pre)), 0.005)
        var_post = max(float(np.var(post)), 0.005)

        # Gaussian log-likelihoods
        ll_pre = -0.5 * len(pre) * np.log(2 * np.pi * var_pre) - np.sum((pre - mu_pre) ** 2) / (2 * var_pre)
        ll_post = -0.5 * len(post) * np.log(2 * np.pi * var_post) - np.sum((post - mu_post) ** 2) / (2 * var_post)

        return float(ll_pre + ll_post)

    def detect_change_point(self, confidence_sequence: list) -> dict:
        seq = np.array(confidence_sequence, dtype=float)
        N = len(seq)

        # We need at least 5 reports in a cluster to safely estimate a change point
        if N < 5:
            return {
                'change_detected': False,
                'posterior_probability': 0.0,
                'change_point_index': None,
                'pre_mean': float(np.mean(seq)) if N > 0 else 0.0,
                'post_mean': float(np.mean(seq)) if N > 0 else 0.0
            }

        # Initialize change point at the center of the sequence
        tau = N // 2
        accepted_taus = []

        for i in range(self.n_samples + self.burn_in):
            # Propose new tau using a random walk step
            step = int(np.random.choice([-2, -1, 1, 2]))
            tau_proposed = int(np.clip(tau + step, 1, N - 2))

            # Current posterior
            lp_current = self.log_prior(tau, N)
            ll_current = self.log_likelihood(seq, tau)
            post_current = lp_current + ll_current

            # Proposed posterior
            lp_proposed = self.log_prior(tau_proposed, N)
            ll_proposed = self.log_likelihood(seq, tau_proposed)
            post_proposed = lp_proposed + ll_proposed

            # Accept/Reject step in log space
            log_alpha = post_proposed - post_current
            if np.log(np.random.uniform(0, 1)) < log_alpha:
                tau = tau_proposed

            if i >= self.burn_in:
                accepted_taus.append(tau)

        if not accepted_taus:
            return {
                'change_detected': False,
                'posterior_probability': 0.0,
                'change_point_index': None,
                'pre_mean': float(np.mean(seq)),
                'post_mean': float(np.mean(seq))
            }

        taus = np.array(accepted_taus)

        # Find the maximum a posteriori (MAP) estimate of the change point
        values, counts = np.unique(taus, return_counts=True)
        map_tau = int(values[np.argmax(counts)])
        posterior_prob = float(counts.max() / len(taus))

        pre_mean = float(np.mean(seq[:map_tau]))
        post_mean = float(np.mean(seq[map_tau:]))

        # We confirm a genuine change point if:
        # 1. The posterior probability is sufficiently high (meaning sampler converged).
        # 2. The mean confidence of reports rises after the change point.
        change_detected = bool(
            posterior_prob > 0.35 and
            post_mean > pre_mean + 0.1
        )

        return {
            'change_detected': change_detected,
            'posterior_probability': posterior_prob,
            'change_point_index': map_tau,
            'pre_mean': pre_mean,
            'post_mean': post_mean
        }
