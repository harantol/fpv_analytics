import { describe, expect, it } from 'vitest';
import { packetRate } from '../src/elrs';

describe('débit de paquets ELRS (champ RFMD)', () => {
  it('ELRS 4.x : 900 MHz, 2,4 GHz et double bande', () => {
    expect(packetRate('7', 4)).toMatchObject({ hz: 250, label: '250 Hz', detail: 'LoRa 900 MHz' });
    expect(packetRate('21', 4)).toMatchObject({ hz: 50, detail: 'LoRa 2,4 GHz' });
    expect(packetRate('33', 4)).toMatchObject({ hz: 1000, detail: 'FLRC 2,4 GHz' });
    expect(packetRate('23', 4)?.label).toBe('100 Hz 8 voies');
    expect(packetRate('100', 4)?.detail).toBe('LoRa double bande');
  });

  it('ELRS 3.x : numérotation différente', () => {
    expect(packetRate('7', 3)).toMatchObject({ hz: 250 });
    expect(packetRate('0', 3)).toMatchObject({ hz: 4 });
    expect(packetRate('0', 4)).toMatchObject({ hz: 25 });
    expect(packetRate('13', 3)).toMatchObject({ hz: 1000, detail: 'FLRC' });
  });

  it('valeur inconnue ou absente', () => {
    expect(packetRate(undefined, 4)).toBeNull();
    expect(packetRate('15', 4)).toBeNull();
    expect(packetRate('D250', 4)).toBeNull();
  });
});
