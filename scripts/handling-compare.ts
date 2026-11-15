/**
 * v0.6.2 핸들링 변경 전후 비교(수치). 이전 = 순수 기구학(뒷바퀴 횡미끄럼 0, 접지 한계 없음), 이후 = stepVehicle(저속 기구학 + 고속 동역학).
 *   npx tsx scripts/handling-compare.ts
 */
import { createVehicleState, maxSteerAt, stepVehicle } from '../src/vehicle/physics';
import { getVehicle } from '../src/vehicle/spec';
import { handlingOf, understeerGradient } from '../src/vehicle/handling';

const rows: string[] = [];
for (const id of ['compact', 'sedan', 'suv', 'coupe-m4', 'suv-x6']) {
  const spec = getVehicle(id);
  const H = handlingOf(spec);
  const out: Record<string, string> = { 차종: id };
  out['최소 회전반경(m, 저속)'] = (spec.wheelbase / Math.tan(spec.maxSteer)).toFixed(2) + ' → 동일';
  for (const kmh of [30, 60, 90]) {
    const v = kmh / 3.6;
    const d = maxSteerAt(spec, v);
    const ayOld = (v * v * Math.tan(d)) / spec.wheelbase;
    const car = createVehicleState(spec, 0, 0, 0);
    car.gear = 'D';
    car.v = v;
    let ay = 0;
    let t63 = NaN;
    let rSS = 0;
    const samples: [number, number][] = [];
    for (let t = 0; t < 4; t += 1 / 240) {
      stepVehicle(car, { throttle: 0, brake: 0, steerInput: 1 }, spec, 1 / 240);
      car.v = v;
      samples.push([t, car.yawRate!]);
      ay = Math.max(ay, Math.abs(car.ay!));
    }
    rSS = samples[samples.length - 1][1];
    for (const [t, r] of samples) if (Number.isNaN(t63) && Math.abs(r) >= 0.63 * Math.abs(rSS)) t63 = t;
    out[`${kmh}km/h 풀조향 횡G (이전→이후)`] = `${(ayOld / 9.81).toFixed(2)}g → ${(ay / 9.81).toFixed(2)}g`;
    out[`${kmh}km/h 요 응답 63%(s)`] = `0 → ${t63.toFixed(2)}`;
  }
  out['언더스티어 구배(deg/g)'] = ((understeerGradient(H, spec.wheelbase) * 9.81 * 180) / Math.PI).toFixed(2);
  out['질량/앞축비/무게중심'] = `${H.mass}kg / ${H.frontWeight} / ${H.cgHeight}m (추정)`;
  rows.push(JSON.stringify(out));
}
console.log(rows.join('\n'));
