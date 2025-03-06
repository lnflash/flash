import CurrencyMap from '@services/ibex/currencies/CurrencyMap';
import { WalletCurrency } from '@domain/shared';
import { UnsupportedCurrencyError } from '@domain/errors';
import USDollars from '@services/ibex/currencies/USDollars';

describe('CurrencyMap', () => {
  describe('getCurrencyId', () => {
    it('should return the correct currencyId for supported currencies', () => {
      const currencyId = CurrencyMap.getCurrencyId(WalletCurrency.Usd);
      expect(currencyId).toBe(3);
    });

    it('should return an UnsupportedCurrencyError for unsupported currencies', () => {
      const unsupportedCurrency = WalletCurrency.Btc; 
      const result = CurrencyMap.getCurrencyId(unsupportedCurrency);
      expect(result).toBeInstanceOf(UnsupportedCurrencyError);
    });
  });
});