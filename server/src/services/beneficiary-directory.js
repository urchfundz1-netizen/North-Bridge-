/**
 * Hardcoded beneficiary directory.
 *
 * When a customer types one of these account numbers on the transfer form the
 * client calls the lookup endpoint and auto-fills the recipient details.
 * Numbers that are not listed resolve to `found: false` and the form stays
 * fully manual.
 */

export const BENEFICIARY_DIRECTORY = [
  {
    accountNumber: '621048372051001',
    accountName: 'China Heavy Machinery Trading Co.',
    beneficiaryName: 'Zhang Wei',
    bankName: 'Bank of China',
    cnapsCode: '105584321017',
    swiftBic: 'BKCHCNBJXXX',
    country: 'China',
  },
  {
    accountNumber: '622271945830002',
    accountName: 'Sino Industrial Supplies Ltd.',
    beneficiaryName: 'Li Ming',
    bankName: 'ICBC',
    cnapsCode: '302110784625',
    swiftBic: 'ICBKCNBJXXX',
    country: 'China',
  },
  {
    accountNumber: '621730581946003',
    accountName: 'Huaxing Construction Group',
    beneficiaryName: 'Wang Fang',
    bankName: 'China Construction Bank',
    cnapsCode: '440305918276',
    swiftBic: 'PCBCCNBJXXX',
    country: 'China',
  },
  {
    accountNumber: '622846019375004',
    accountName: 'Eastern Engineering Solutions Ltd.',
    beneficiaryName: 'Liu Yang',
    bankName: 'Agricultural Bank of China',
    cnapsCode: '510581726394',
    swiftBic: 'ABOCCNBJXXX',
    country: 'China',
  },
  {
    accountNumber: '621285736149005',
    accountName: 'Pacific Machinery Trading Co.',
    beneficiaryName: 'Chen Jie',
    bankName: 'Bank of Communications',
    cnapsCode: '330100649281',
    swiftBic: 'COMMCNSHXXX',
    country: 'China',
  },
  {
    accountNumber: '621409367285006',
    accountName: 'Global Infrastructure Services Ltd.',
    beneficiaryName: 'Zhao Lei',
    bankName: 'China Merchants Bank',
    cnapsCode: '440300827516',
    swiftBic: 'CMBCCNBSXXX',
    country: 'China',
  },
  {
    accountNumber: '622618453907007',
    accountName: 'Sino Earthmoving Machinery Co.',
    beneficiaryName: 'Huang Lin',
    bankName: 'China CITIC Bank',
    cnapsCode: '110105392847',
    swiftBic: 'CIBKCNBJXXX',
    country: 'China',
  },
  {
    accountNumber: '622657208413008',
    accountName: 'Eastern Industrial Supply Co.',
    beneficiaryName: 'Yang Chen',
    bankName: 'China Everbright Bank',
    cnapsCode: '310115746209',
    swiftBic: 'EVERCNBJXXX',
    country: 'China',
  },
  {
    accountNumber: '622163941078009',
    accountName: 'Prime Construction Materials Ltd.',
    beneficiaryName: 'Xu Jun',
    bankName: 'Ping An Bank',
    cnapsCode: '440305281763',
    swiftBic: 'SZDBCNBSXXX',
    country: 'China',
  },
  {
    accountNumber: '622940572861010',
    accountName: 'Oriental Manufacturing & Trading Co.',
    beneficiaryName: 'Sun Mei',
    bankName: 'Industrial Bank',
    cnapsCode: '350102694185',
    swiftBic: 'FJIBCNBAXXX',
    country: 'China',
  },
];

/** Look up a directory entry by account number, ignoring separators. */
export function findBeneficiaryByAccountNumber(accountNumber) {
  const normalized = typeof accountNumber === 'string' ? accountNumber.replace(/[\s-]/g, '') : '';
  if (!normalized) return null;
  return BENEFICIARY_DIRECTORY.find((entry) => entry.accountNumber === normalized) ?? null;
}
