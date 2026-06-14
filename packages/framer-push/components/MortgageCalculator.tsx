// Mortgage Calculator — Esperanza Homes payment estimator.
// Fetches site-wide mortgage_rate from GET /api/public/settings on load.
// Colors/fonts align with QMI / Floor Plans catalog components.

import { addPropertyControls, ControlType } from "framer"
import { useEffect, useMemo, useState, type CSSProperties } from "react"

const PMI_RATE = 0.0075

interface MortgageCalculatorProps {
    primaryColor?: string
    backgroundColor?: string
    textColor?: string
    inputBackgroundColor?: string
    inputTextColor?: string
    accentColor?: string
    buttonColor?: string
    buttonTextColor?: string
    resetButtonColor?: string
    fontFamily?: string
    apiBaseUrl?: string
    homePrice?: number
    defaultPrice?: number
    defaultDownPaymentPercent?: number
    defaultHomeInsurance?: number
    defaultMortgageRate?: number
    defaultTerm?: number
    defaultTaxes?: number
    style?: CSSProperties
}

function num(v: string | number): number {
    const n = parseFloat(String(v))
    return isFinite(n) ? n : 0
}

function formatCurrency(value: number) {
    const safe = isFinite(value) ? value : 0
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(safe)
}

/**
 * @framerSupportedLayoutWidth fixed
 * @framerSupportedLayoutHeight auto
 */
export default function MortgageCalculator(props: MortgageCalculatorProps) {
    const {
        primaryColor = "#407e52",
        backgroundColor = "#F3F1ED",
        textColor = "#3c3c3c",
        inputBackgroundColor = "#FFFFFF",
        inputTextColor = "#3c3c3c",
        accentColor = "#407e52",
        buttonColor = "#407e52",
        buttonTextColor = "#FFFFFF",
        resetButtonColor = "#4B5563",
        fontFamily = "'Overpass', sans-serif",
        apiBaseUrl = "https://esperanza-api.round-base-ed8c.workers.dev",
        homePrice = 0,
        defaultPrice = 200000,
        defaultDownPaymentPercent = 3.5,
        defaultHomeInsurance = 800.04,
        defaultMortgageRate = 6.15,
        defaultTerm = 30,
        defaultTaxes = 2000,
        style,
    } = props

    const seedPrice = homePrice > 0 ? homePrice : defaultPrice

    const insuranceRate = useMemo(
        () => (defaultPrice > 0 ? defaultHomeInsurance / defaultPrice : 0),
        [defaultPrice, defaultHomeInsurance]
    )
    const taxRate = useMemo(
        () => (defaultPrice > 0 ? defaultTaxes / defaultPrice : 0),
        [defaultPrice, defaultTaxes]
    )

    const [price, setPrice] = useState(String(seedPrice))
    const [downPaymentPercent, setDownPaymentPercent] = useState(
        String(defaultDownPaymentPercent)
    )
    const [homeInsurance, setHomeInsurance] = useState(
        String((seedPrice * insuranceRate).toFixed(2))
    )
    const [mortgageRate, setMortgageRate] = useState(
        String(defaultMortgageRate)
    )
    const [siteMortgageRate, setSiteMortgageRate] = useState(defaultMortgageRate)
    const [term, setTerm] = useState(defaultTerm)
    const [taxes, setTaxes] = useState(String((seedPrice * taxRate).toFixed(2)))
    const [includePMI, setIncludePMI] = useState(true)
    const [hoveredTip, setHoveredTip] = useState<string | null>(null)

    useEffect(() => {
        const base = apiBaseUrl.replace(/\/$/, "")
        let cancelled = false
        fetch(`${base}/api/public/settings`)
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => {
                if (cancelled || !json?.settings) return
                const rate = num(json.settings.mortgage_rate)
                if (rate > 0) {
                    setSiteMortgageRate(rate)
                    setMortgageRate(String(rate))
                }
            })
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [apiBaseUrl])

    useEffect(() => {
        if (homePrice <= 0) return
        setPrice(String(homePrice))
        setHomeInsurance((homePrice * insuranceRate).toFixed(2))
        setTaxes((homePrice * taxRate).toFixed(2))
    }, [homePrice, insuranceRate, taxRate])

    const priceNum = num(price)
    const pctNum = num(downPaymentPercent)
    const insuranceNum = num(homeInsurance)
    const rateNum = num(mortgageRate)
    const taxesNum = num(taxes)

    const handlePriceChange = (raw: string) => {
        setPrice(raw)
        const p = num(raw)
        setHomeInsurance((p * insuranceRate).toFixed(2))
        setTaxes((p * taxRate).toFixed(2))
    }

    const downPaymentAmount = (priceNum * pctNum) / 100
    const principal = Math.max(priceNum - downPaymentAmount, 0)
    const pmiRequired = pctNum < 20
    const pmiAmount =
        pmiRequired && includePMI ? (principal * PMI_RATE) / 12 : 0

    const monthlyPayment = (() => {
        const monthlyRate = rateNum / 100 / 12
        const numberOfPayments = term * 12
        if (numberOfPayments <= 0) return 0

        let monthlyPI = 0
        if (monthlyRate === 0) {
            monthlyPI = principal / numberOfPayments
        } else {
            monthlyPI =
                (principal *
                    (monthlyRate *
                        Math.pow(1 + monthlyRate, numberOfPayments))) /
                (Math.pow(1 + monthlyRate, numberOfPayments) - 1)
        }

        return monthlyPI + taxesNum / 12 + insuranceNum / 12 + pmiAmount
    })()

    const TOOLTIPS = {
        price: "Enter the price of the home you want to buy. You can also enter the amount that you think you will offer.",
        down: "Most home loans require a down payment of at least 3%. A higher down payment will lower your monthly payment.",
        insurance:
            "Home insurance or homeowners insurance is typically required by lenders. It covers damages to your home and personal assets.",
        rate: "This is pre-filled with the current average mortgage rate. Your actual rate will vary based on factors like credit score and down payment.",
        term: "This is the length of time you choose to pay off your loan.",
        pmi: "Private Mortgage Insurance",
    }

    const handleReset = () => {
        const resetPrice = homePrice > 0 ? homePrice : defaultPrice
        setPrice(String(resetPrice))
        setDownPaymentPercent(String(defaultDownPaymentPercent))
        if (homePrice > 0) {
            setHomeInsurance((resetPrice * insuranceRate).toFixed(2))
            setTaxes((resetPrice * taxRate).toFixed(2))
        } else {
            setHomeInsurance(String(defaultHomeInsurance))
            setTaxes(String(defaultTaxes))
        }
        setMortgageRate(String(siteMortgageRate))
        setTerm(defaultTerm)
        setIncludePMI(true)
    }

    const handleCalculate = () => {
        setHomeInsurance((priceNum * insuranceRate).toFixed(2))
        setTaxes((priceNum * taxRate).toFixed(2))
    }

    const containerStyle: CSSProperties = {
        position: "relative",
        width: "100%",
        height: "100%",
        padding: "clamp(20px, 5vw, 40px)",
        backgroundColor,
        borderRadius: "clamp(8px, 2vw, 16px)",
        border: `3px solid ${primaryColor}`,
        fontFamily,
        boxSizing: "border-box",
        overflow: "visible",
        ...style,
    }

    const topResultStyle: CSSProperties = {
        backgroundColor: inputBackgroundColor,
        padding: "clamp(16px, 4vw, 32px)",
        borderRadius: "clamp(6px, 1.5vw, 12px)",
        textAlign: "center",
        marginBottom: "clamp(16px, 4vw, 32px)",
    }

    const topResultValueStyle: CSSProperties = {
        fontSize: "clamp(24px, 6vw, 48px)",
        fontWeight: 700,
        color: accentColor,
        margin: 0,
    }

    const rowStyle: CSSProperties = {
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        marginBottom: "clamp(12px, 2.5vw, 20px)",
        gap: "clamp(8px, 2vw, 16px)",
        flexWrap: "wrap",
    }

    const labelStyle: CSSProperties = {
        flex: "0 0 auto",
        minWidth: "clamp(100px, 15vw, 140px)",
        fontSize: "clamp(13px, 1.8vw, 15px)",
        color: textColor,
        fontWeight: 500,
    }

    const inputWrapperStyle: CSSProperties = {
        flex: "1 1 auto",
        display: "flex",
        alignItems: "center",
        gap: "clamp(6px, 1.5vw, 12px)",
        minWidth: 0,
    }

    const fieldBoxStyle: CSSProperties = {
        position: "relative",
        flex: 1,
        minWidth: 0,
        border: "1px solid #E5E7EB",
        borderRadius: "clamp(4px, 1vw, 8px)",
        backgroundColor: inputBackgroundColor,
    }

    const fieldInputStyle: CSSProperties = {
        width: "100%",
        boxSizing: "border-box",
        border: "none",
        outline: "none",
        background: "transparent",
        fontSize: "clamp(14px, 2vw, 16px)",
        color: inputTextColor,
        fontWeight: 500,
        fontFamily,
        minWidth: 0,
    }

    const fieldPadY = "clamp(10px, 1.8vw, 14px)"
    const fieldPadLeft = "clamp(28px, 4.5vw, 36px)"
    const fieldPadRight = "clamp(12px, 2vw, 16px)"
    const fieldPadLeftPlain = "clamp(12px, 2vw, 16px)"
    const fieldPadRightSuffix = "clamp(28px, 4vw, 32px)"
    const fieldPadRightYrs = "clamp(48px, 6.5vw, 56px)"

    const fieldPrefixStyle: CSSProperties = {
        position: "absolute",
        left: "clamp(10px, 2vw, 16px)",
        top: "50%",
        transform: "translateY(-50%)",
        fontSize: "clamp(14px, 2vw, 16px)",
        color: accentColor,
        fontWeight: 600,
        pointerEvents: "none",
        lineHeight: 1,
    }

    const fieldSuffixStyle: CSSProperties = {
        position: "absolute",
        right: "clamp(10px, 2vw, 16px)",
        top: "50%",
        transform: "translateY(-50%)",
        fontSize: "clamp(14px, 2vw, 16px)",
        color: inputTextColor,
        fontWeight: 600,
        pointerEvents: "none",
        lineHeight: 1,
    }

    const dollarSignStyle = fieldPrefixStyle

    const infoIconStyle: CSSProperties = {
        width: "clamp(18px, 2.5vw, 20px)",
        height: "clamp(18px, 2.5vw, 20px)",
        borderRadius: "50%",
        backgroundColor: accentColor,
        color: "#FFFFFF",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "clamp(11px, 1.5vw, 12px)",
        fontWeight: 700,
        cursor: "pointer",
        flexShrink: 0,
    }

    const tooltipWrapperStyle: CSSProperties = {
        position: "relative",
        display: "inline-flex",
        flexShrink: 0,
    }

    const tooltipStyle: CSSProperties = {
        position: "absolute",
        bottom: "calc(100% + 10px)",
        left: "50%",
        transform: "translateX(-50%)",
        backgroundColor: accentColor,
        color: "#FFFFFF",
        padding: "clamp(8px, 1.2vw, 12px) clamp(10px, 1.6vw, 14px)",
        borderRadius: "clamp(3px, 0.75vw, 6px)",
        fontSize: "clamp(11px, 1.6vw, 13px)",
        lineHeight: 1.4,
        width: "clamp(180px, 22vw, 260px)",
        maxWidth: "min(260px, 85vw)",
        zIndex: 10,
        pointerEvents: "none",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        textAlign: "left",
    }

    const tooltipArrowStyle: CSSProperties = {
        position: "absolute",
        top: "100%",
        left: "50%",
        transform: "translateX(-50%)",
        width: 0,
        height: 0,
        borderLeft: "7px solid transparent",
        borderRight: "7px solid transparent",
        borderTop: `7px solid ${accentColor}`,
    }

    const renderInfoIcon = (key: string) => (
        <div
            style={{
                ...tooltipWrapperStyle,
                zIndex: hoveredTip === key ? 10 : undefined,
            }}
        >
            <span
                style={infoIconStyle}
                onMouseEnter={() => setHoveredTip(key)}
                onMouseLeave={() => setHoveredTip(null)}
            >
                i
            </span>
            {hoveredTip === key && (
                <div style={tooltipStyle}>
                    {TOOLTIPS[key as keyof typeof TOOLTIPS]}
                    <div style={tooltipArrowStyle} />
                </div>
            )}
        </div>
    )

    const selectStyle: CSSProperties = {
        ...fieldInputStyle,
        padding: `${fieldPadY} ${fieldPadRightYrs} ${fieldPadY} ${fieldPadLeftPlain}`,
        cursor: "pointer",
        appearance: "none",
        backgroundImage: `url("data:image/svg+xml,%3Csvg width='12' height='8' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%23${inputTextColor.replace("#", "")}' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E")`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right clamp(36px, 5vw, 44px) center",
    }

    const twoColumnStyle: CSSProperties = {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: "clamp(12px, 3vw, 24px)",
        marginBottom: "clamp(12px, 2.5vw, 20px)",
    }

    const columnStyle: CSSProperties = {
        display: "flex",
        flexDirection: "column",
    }

    const pmiSectionStyle: CSSProperties = {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "clamp(6px, 1vw, 8px)",
        marginBottom: "clamp(12px, 3vw, 24px)",
    }

    const pmiLabelRowStyle: CSSProperties = {
        display: "flex",
        alignItems: "center",
        gap: "clamp(6px, 1vw, 8px)",
    }

    const checkboxStyle: CSSProperties = {
        width: "clamp(20px, 3vw, 24px)",
        height: "clamp(20px, 3vw, 24px)",
        accentColor: accentColor,
        cursor: "pointer",
    }

    const buttonRowStyle: CSSProperties = {
        display: "flex",
        justifyContent: "center",
        gap: "clamp(8px, 2vw, 16px)",
        marginTop: "clamp(16px, 4vw, 32px)",
        marginBottom: "clamp(12px, 3vw, 24px)",
        flexWrap: "wrap",
    }

    const calculateButtonStyle: CSSProperties = {
        padding: "clamp(10px, 1.8vw, 14px) clamp(24px, 5vw, 40px)",
        backgroundColor: buttonColor,
        color: buttonTextColor,
        border: "none",
        borderRadius: 50,
        fontSize: "clamp(14px, 2vw, 16px)",
        fontWeight: 600,
        cursor: "pointer",
        transition: "all 0.2s",
        fontFamily,
    }

    const resetButtonStyle: CSSProperties = {
        padding: "clamp(10px, 1.8vw, 14px) clamp(24px, 5vw, 40px)",
        backgroundColor: resetButtonColor,
        color: "#FFFFFF",
        border: "none",
        borderRadius: 50,
        fontSize: "clamp(14px, 2vw, 16px)",
        fontWeight: 600,
        cursor: "pointer",
        transition: "all 0.2s",
        fontFamily,
    }

    const bottomResultStyle: CSSProperties = {
        textAlign: "center",
        marginTop: "clamp(8px, 2vw, 16px)",
    }

    const bottomResultLabelStyle: CSSProperties = {
        fontSize: "clamp(12px, 1.8vw, 14px)",
        color: textColor,
        marginBottom: "clamp(4px, 1vw, 8px)",
        fontWeight: 500,
        opacity: 0.7,
    }

    const bottomResultValueStyle: CSSProperties = {
        fontSize: "clamp(24px, 4.5vw, 36px)",
        fontWeight: 700,
        color: accentColor,
        margin: 0,
    }

    return (
        <div style={containerStyle}>
            <div style={topResultStyle}>
                <div style={topResultValueStyle}>
                    {formatCurrency(monthlyPayment)}
                </div>
            </div>

            <div style={rowStyle}>
                <div style={labelStyle}>Price</div>
                <div style={inputWrapperStyle}>
                    <div style={fieldBoxStyle}>
                        <span style={dollarSignStyle}>$</span>
                        <input
                            type="number"
                            min="0"
                            inputMode="decimal"
                            style={{
                                ...fieldInputStyle,
                                padding: `${fieldPadY} ${fieldPadRight} ${fieldPadY} ${fieldPadLeft}`,
                            }}
                            value={price}
                            onChange={(e) => handlePriceChange(e.target.value)}
                        />
                    </div>
                    {renderInfoIcon("price")}
                </div>
            </div>

            <div style={rowStyle}>
                <div style={labelStyle}>Down Payment</div>
                <div style={inputWrapperStyle}>
                    <div style={fieldBoxStyle}>
                        <span style={dollarSignStyle}>$</span>
                        <input
                            type="number"
                            step="500"
                            min="0"
                            inputMode="decimal"
                            style={{
                                ...fieldInputStyle,
                                padding: `${fieldPadY} ${fieldPadRight} ${fieldPadY} ${fieldPadLeft}`,
                            }}
                            value={
                                priceNum > 0
                                    ? String(Math.round(downPaymentAmount))
                                    : "0"
                            }
                            onChange={(e) => {
                                const amount = num(e.target.value)
                                setDownPaymentPercent(
                                    priceNum > 0
                                        ? ((amount / priceNum) * 100).toFixed(2)
                                        : "0"
                                )
                            }}
                        />
                    </div>
                    <div
                        style={{
                            ...fieldBoxStyle,
                            flex: "0 1 auto",
                            maxWidth: "clamp(90px, 12vw, 110px)",
                        }}
                    >
                        <input
                            type="number"
                            step="0.1"
                            min="0"
                            inputMode="decimal"
                            style={{
                                ...fieldInputStyle,
                                padding: `${fieldPadY} ${fieldPadRightSuffix} ${fieldPadY} ${fieldPadLeftPlain}`,
                                textAlign: "right",
                            }}
                            value={downPaymentPercent}
                            onChange={(e) =>
                                setDownPaymentPercent(e.target.value)
                            }
                        />
                        <span style={fieldSuffixStyle}>%</span>
                    </div>
                    {renderInfoIcon("down")}
                </div>
            </div>

            <div style={rowStyle}>
                <div style={labelStyle}>Home Insurance</div>
                <div style={inputWrapperStyle}>
                    <div style={fieldBoxStyle}>
                        <span style={dollarSignStyle}>$</span>
                        <input
                            type="number"
                            step="10"
                            min="0"
                            inputMode="decimal"
                            style={{
                                ...fieldInputStyle,
                                padding: `${fieldPadY} ${fieldPadRight} ${fieldPadY} ${fieldPadLeft}`,
                            }}
                            value={homeInsurance}
                            onChange={(e) => setHomeInsurance(e.target.value)}
                        />
                    </div>
                    {renderInfoIcon("insurance")}
                </div>
            </div>

            <div style={rowStyle}>
                <div style={labelStyle}>Mortgage Rate</div>
                <div style={inputWrapperStyle}>
                    <div style={fieldBoxStyle}>
                        <input
                            type="number"
                            step="0.01"
                            min="0"
                            inputMode="decimal"
                            style={{
                                ...fieldInputStyle,
                                padding: `${fieldPadY} ${fieldPadRightSuffix} ${fieldPadY} ${fieldPadLeftPlain}`,
                            }}
                            value={mortgageRate}
                            onChange={(e) => setMortgageRate(e.target.value)}
                        />
                        <span style={fieldSuffixStyle}>%</span>
                    </div>
                    {renderInfoIcon("rate")}
                </div>
            </div>

            <div style={twoColumnStyle}>
                <div style={columnStyle}>
                    <div style={labelStyle}>Term</div>
                    <div style={inputWrapperStyle}>
                        <div style={fieldBoxStyle}>
                            <select
                                style={selectStyle}
                                value={term}
                                onChange={(e) =>
                                    setTerm(Number(e.target.value))
                                }
                            >
                                <option value={15}>15</option>
                                <option value={30}>30</option>
                                <option value={40}>40</option>
                            </select>
                            <span style={fieldSuffixStyle}>Yrs.</span>
                        </div>
                        {renderInfoIcon("term")}
                    </div>
                </div>

                <div style={columnStyle}>
                    <div style={labelStyle}>Taxes</div>
                    <div style={inputWrapperStyle}>
                        <div style={fieldBoxStyle}>
                            <span style={dollarSignStyle}>$</span>
                            <input
                                type="number"
                                step="100"
                                min="0"
                                inputMode="decimal"
                                style={{
                                    ...fieldInputStyle,
                                    padding: `${fieldPadY} ${fieldPadRight} ${fieldPadY} ${fieldPadLeft}`,
                                }}
                                value={taxes}
                                onChange={(e) => setTaxes(e.target.value)}
                            />
                        </div>
                    </div>
                </div>
            </div>

            <div style={pmiSectionStyle}>
                <div style={pmiLabelRowStyle}>
                    <span style={{ ...labelStyle, minWidth: 0 }}>PMI</span>
                    {renderInfoIcon("pmi")}
                </div>
                <input
                    type="checkbox"
                    checked={pmiRequired && includePMI}
                    disabled={!pmiRequired}
                    onChange={(e) => setIncludePMI(e.target.checked)}
                    style={checkboxStyle}
                />
            </div>

            <div style={buttonRowStyle}>
                <button style={calculateButtonStyle} onClick={handleCalculate}>
                    CALCULATE
                </button>
                <button style={resetButtonStyle} onClick={handleReset}>
                    RESET
                </button>
            </div>

            <div style={bottomResultStyle}>
                <div style={bottomResultLabelStyle}>
                    Estimated monthly Payment
                </div>
                <div style={bottomResultValueStyle}>
                    {formatCurrency(monthlyPayment)}
                </div>
            </div>
        </div>
    )
}

addPropertyControls(MortgageCalculator, {
    apiBaseUrl: {
        type: ControlType.String,
        title: "API Base URL",
        defaultValue: "https://esperanza-api.round-base-ed8c.workers.dev",
        description: "Fetches site-wide mortgage_rate from /api/public/settings",
    },
    homePrice: {
        type: ControlType.Number,
        title: "Home Price",
        defaultValue: 0,
        min: 0,
        step: 1000,
        description: "0 = use Default Price. Bind to CMS price on detail pages.",
    },
    primaryColor: {
        type: ControlType.Color,
        title: "Border Color",
        defaultValue: "#407e52",
    },
    backgroundColor: {
        type: ControlType.Color,
        title: "Background",
        defaultValue: "#F3F1ED",
    },
    textColor: {
        type: ControlType.Color,
        title: "Text Color",
        defaultValue: "#3c3c3c",
    },
    inputBackgroundColor: {
        type: ControlType.Color,
        title: "Input Background",
        defaultValue: "#FFFFFF",
    },
    inputTextColor: {
        type: ControlType.Color,
        title: "Input Text Color",
        defaultValue: "#3c3c3c",
    },
    accentColor: {
        type: ControlType.Color,
        title: "Accent Color",
        defaultValue: "#407e52",
    },
    buttonColor: {
        type: ControlType.Color,
        title: "Button Color",
        defaultValue: "#407e52",
    },
    buttonTextColor: {
        type: ControlType.Color,
        title: "Button Text Color",
        defaultValue: "#FFFFFF",
    },
    resetButtonColor: {
        type: ControlType.Color,
        title: "Reset Button Color",
        defaultValue: "#4B5563",
    },
    fontFamily: {
        type: ControlType.String,
        title: "Font Family",
        defaultValue: "'Overpass', sans-serif",
    },
    defaultPrice: {
        type: ControlType.Number,
        title: "Default Price",
        defaultValue: 200000,
        min: 0,
        step: 1000,
    },
    defaultDownPaymentPercent: {
        type: ControlType.Number,
        title: "Default Down Payment %",
        defaultValue: 3.5,
        min: 0,
        max: 100,
        step: 0.1,
        unit: "%",
    },
    defaultHomeInsurance: {
        type: ControlType.Number,
        title: "Default Home Insurance",
        defaultValue: 800.04,
        min: 0,
        step: 10,
    },
    defaultMortgageRate: {
        type: ControlType.Number,
        title: "Default Mortgage Rate",
        defaultValue: 6.15,
        min: 0,
        max: 20,
        step: 0.01,
        unit: "%",
        description: "Fallback until API settings load",
    },
    defaultTerm: {
        type: ControlType.Enum,
        title: "Default Term",
        defaultValue: 30,
        options: [15, 30, 40],
        optionTitles: ["15 years", "30 years", "40 years"],
    },
    defaultTaxes: {
        type: ControlType.Number,
        title: "Default Taxes",
        defaultValue: 2000,
        min: 0,
        step: 100,
    },
})
