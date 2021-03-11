export interface PricingModel {
  version: string;
  timestamp: Date;
  priceUnit: string;
  pricingItems: PricingItem[];
}

export interface PricingItem {
  category: PricingCategory;
  precisionPrice: number;
  calculatedPrice: number;
  calculatedRoudedPrice: number;
}

export enum PricingCategory {
  CONSUMPTION = 'consumption',
}

export interface KWHPricingItem extends PricingItem {
  pricePerKWH: number;
}


export interface PricedConsumption {
  amount: number;
  cumulatedAmount: number;
  roundedAmount: number;
  currencyCode: string;
  pricingSource: string;
}
