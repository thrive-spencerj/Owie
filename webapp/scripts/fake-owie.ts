// Simulates Owie boards posting telemetry. Usage:
//   bun run scripts/fake-owie.ts [numBoards]
// Env: OWIE_URL (default http://localhost:8020), SPEEDUP (default 10)

const BASE_URL = process.env.OWIE_URL ?? "http://localhost:8020";
const SPEEDUP = Number(process.env.SPEEDUP ?? 10);
const NUM_BOARDS = Number(process.argv[2] ?? 3);

type Phase = "idle" | "ride" | "charge";

class FakeBoard {
  chipId: string;
  soc = 60 + Math.random() * 35;
  usedMah = Math.round(Math.random() * 50_000);
  regenMah = Math.round(this.usedMah * 0.1);
  uptimeS = 0;
  phase: Phase = "idle";
  phaseRemainingS = 30;
  weakCell = Math.floor(Math.random() * 15);
  capacityMah = 14000 + Math.random() * 2000;

  constructor(i: number) {
    this.chipId = (0xa000 + i).toString(16);
  }

  private nextPhase(): void {
    if (this.phase === "ride" || this.soc < 15) {
      this.phase = this.soc < 90 && Math.random() < 0.6 ? "charge" : "idle";
    } else if (this.phase === "charge" || this.soc > 95) {
      this.phase = "idle";
    } else {
      this.phase = Math.random() < 0.7 ? "ride" : "charge";
    }
    this.phaseRemainingS =
      this.phase === "idle" ? 60 + Math.random() * 120 : 300 + Math.random() * 600;
  }

  tick(dtS: number): Record<string, unknown> {
    this.uptimeS += dtS;
    this.phaseRemainingS -= dtS;
    if (this.phaseRemainingS <= 0) this.nextPhase();

    let currentMa = 0;
    if (this.phase === "ride") {
      currentMa = 4000 + Math.random() * 12000; // 4-16 A discharge
      if (Math.random() < 0.1) currentMa = -(1000 + Math.random() * 3000); // regen braking
    } else if (this.phase === "charge") {
      currentMa = -(3000 + Math.random() * 500);
    }

    const mahMoved = (Math.abs(currentMa) * dtS) / 3600;
    if (currentMa > 0) {
      this.usedMah += mahMoved;
      this.soc -= (mahMoved / this.capacityMah) * 100;
    } else if (currentMa < 0) {
      this.regenMah += mahMoved;
      this.soc += (mahMoved / this.capacityMah) * 100;
    }
    this.soc = Math.min(100, Math.max(0, this.soc));

    // 15S pack: ~3.0V empty to ~4.2V full per cell.
    const cellBase = 3000 + this.soc * 12;
    const cells = Array.from({ length: 15 }, (_, i) => {
      let v = cellBase + (Math.random() - 0.5) * 20;
      if (i === this.weakCell) v -= 30 + (100 - this.soc);
      return Math.round(v);
    });
    const totalMv = cells.reduce((a, b) => a + b, 0);
    const baseTemp = this.phase === "ride" ? 30 : 20;
    const temps = Array.from({ length: 5 }, () =>
      Math.round(baseTemp + (Math.random() - 0.5) * 4),
    );

    return {
      chip_id: this.chipId,
      bms_serial: 100000 + parseInt(this.chipId, 16),
      fw_version: "2.0.0-dev",
      uptime_s: Math.round(this.uptimeS),
      total_mv: totalMv,
      current_ma: Math.round(currentMa),
      bms_soc: Math.round(this.soc),
      overridden_soc: Math.round(this.soc),
      voltage_soc: Math.round(this.soc),
      cells_mv: cells,
      temps_c: temps,
      charging: this.phase === "charge",
      status_byte: this.phase === "charge" ? 0x20 : 0,
      used_mah: Math.round(this.usedMah),
      regen_mah: Math.round(this.regenMah),
    };
  }

  intervalS(): number {
    return this.phase === "idle" ? 30 : 2;
  }
}

const boards = Array.from({ length: NUM_BOARDS }, (_, i) => new FakeBoard(i));
console.log(
  `fake-owie: ${NUM_BOARDS} boards -> ${BASE_URL}/api/ingest (speedup ${SPEEDUP}x)`,
);

for (const b of boards) {
  (async () => {
    for (;;) {
      const dtS = b.intervalS();
      const payload = b.tick(dtS);
      try {
        const res = await fetch(`${BASE_URL}/api/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.status !== 204) {
          console.error(`${b.chipId}: HTTP ${res.status} ${await res.text()}`);
        }
      } catch (e) {
        console.error(`${b.chipId}: ${e}`);
      }
      await Bun.sleep((dtS * 1000) / SPEEDUP);
    }
  })();
}
