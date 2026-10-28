/* Which gates have an airliner parked at them. Real ramps are never all full: overall about a third to
   two thirds of the jet gates, with some concourses busy and others quiet, remote stands used less, and
   the cargo ramp on its own schedule. A fresh mix each time an airport loads. */
(function (root) {
    'use strict';

    const forJets = gate => gate.categories.some(c => c === 'jets' || c === 'heavy');

    // The concourse a gate belongs to: the letters its name starts with ("B10" is B, "NC13" is NC).
    function groupOf(gate) {
        if (gate.operation === 'cargo') return 'cargo';
        if (gate.kind !== 'gate') return 'remote';
        return gate.name.match(/^[A-Z]+/i)?.[0].toUpperCase() || 'other';
    }

    function chooseParked(gates, random = Math.random) {
        const overall = 0.3 + random() * 0.3;
        const busyness = new Map();
        const clamp = v => Math.min(0.9, Math.max(0.05, v));
        return gates.filter(forJets).filter(gate => {
            const group = groupOf(gate);
            if (!busyness.has(group)) {
                busyness.set(group, group === 'cargo' ? 0.3 + random() * 0.5 :
                    clamp(overall * (group === 'remote' ? 0.4 : 0.4 + random() * 1.2)));
            }
            return random() < busyness.get(group);
        });
    }

    const api = { chooseParked, groupOf };
    root.RampLogic = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
