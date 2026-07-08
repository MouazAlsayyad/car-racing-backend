const PressThrottle = require('../pressThrottle');

describe('PressThrottle', () => {
  let throttle;

  beforeEach(() => {
    throttle = new PressThrottle(3);
  });

  test('allows presses within the rate limit', () => {
    expect(throttle.allowPress('player_1')).toBe(true);
    expect(throttle.allowPress('player_1')).toBe(true);
    expect(throttle.allowPress('player_1')).toBe(true);
  });

  test('blocks presses exceeding the rate limit', () => {
    throttle.allowPress('player_1');
    throttle.allowPress('player_1');
    throttle.allowPress('player_1');
    expect(throttle.allowPress('player_1')).toBe(false);
  });

  test('tracks different players independently', () => {
    throttle.allowPress('player_1');
    throttle.allowPress('player_1');
    throttle.allowPress('player_1');
    expect(throttle.allowPress('player_2')).toBe(true);
  });

  test('allows presses after the time window passes', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    throttle.allowPress('player_1');
    throttle.allowPress('player_1');
    throttle.allowPress('player_1');
    expect(throttle.allowPress('player_1')).toBe(false);

    jest.spyOn(Date, 'now').mockReturnValue(now + 1001);
    expect(throttle.allowPress('player_1')).toBe(true);
    jest.restoreAllMocks();
  });

  test('reset clears player timestamps', () => {
    throttle.allowPress('player_1');
    throttle.allowPress('player_1');
    throttle.allowPress('player_1');
    throttle.reset('player_1');
    expect(throttle.allowPress('player_1')).toBe(true);
  });

  test('does not block if below limit', () => {
    expect(throttle.allowPress('player_1')).toBe(true);
    expect(throttle.allowPress('player_1')).toBe(true);
  });
});