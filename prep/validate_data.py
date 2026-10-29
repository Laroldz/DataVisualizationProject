
from pathlib import Path
import pandas as pd

# Locate the project folder so the script works from any directory.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_FOLDER = PROJECT_ROOT / "web" / "data"


def check_county_data():
    """Check the county-level dataset for basic data quality issues."""

    county_file = DATA_FOLDER / "county_year.csv"

    if not county_file.exists():
        print("County dataset not found.")
        return

    # Load the processed county-level crash data.
    county_data = pd.read_csv(county_file)

    print("County Data Validation")
    print("----------------------")
    print(f"Total records: {len(county_data):,}")

    # Check whether any columns contain missing values.
    missing_values = county_data.isna().sum()
    print("\nMissing values by column:")
    print(missing_values.to_string())

    # Each county should have only one record per year.
    duplicate_count = county_data.duplicated(
        subset=["year", "fips"]
    ).sum()

    print(f"\nDuplicate county-year records: {duplicate_count}")


    # A fatal crash should have at least one recorded fatality.
    invalid_counts = county_data[
        county_data["fatals"] < county_data["crashes"]
    ]

    print(f"\nRecords with fatalities below crash counts: {len(invalid_counts)}")

    if not invalid_counts.empty:
        print("\nRecords requiring investigation:")
        print(invalid_counts.to_string(index=False))
    

    # Counts and population should never be negative.
    numeric_columns = ["crashes", "fatals", "pop"]

    negative_values = (county_data[numeric_columns] < 0).sum()

    print("\nNegative values by column:")
    print(negative_values.to_string())


    # Identify counties with fatalities but no population estimate.
    zero_population = county_data[
        (county_data["pop"] == 0) &
        (county_data["fatals"] > 0)
    ]

    print(f"\nRecords with fatalities but zero population: {len(zero_population)}")

    if not zero_population.empty:
        print("\nSample records:")
        print(zero_population.head(10).to_string(index=False))
    


    # Summarize missing population estimates by year.
    zero_pop_by_year = (
        zero_population.groupby("year")
        .size()
        .reset_index(name="affected_counties")
    )

    print("\nZero-population records by year:")
    print(zero_pop_by_year.to_string(index=False))


    # Count fatalities affected by missing population estimates.
    affected_fatalities = zero_population["fatals"].sum()
    total_fatalities = county_data["fatals"].sum()

    affected_percentage = (
        affected_fatalities / total_fatalities * 100
        if total_fatalities > 0 else 0
    )

    print("\nImpact of zero-population records:")
    print(f"Fatalities affected: {affected_fatalities:,}")
    print(f"Total county-level fatalities: {total_fatalities:,}")
    print(f"Percentage affected: {affected_percentage:.3f}%")


def check_state_county_totals():
    """Compare state fatality totals with aggregated county totals."""

    state_data = pd.read_csv(DATA_FOLDER / "state_year.csv")
    county_data = pd.read_csv(DATA_FOLDER / "county_year.csv")

    # The first part of a county FIPS code identifies its state.
    county_data["state"] = county_data["fips"] // 1000

    # Add county fatalities together for each state and year.
    county_totals = (
        county_data.groupby(["year", "state"])["fatals"]
        .sum()
        .reset_index(name="county_fatals")
    )

    # Match the county totals with the state-level dataset.
    comparison = state_data.merge(
        county_totals,
        on=["year", "state"],
        how="left"
    )

    comparison["county_fatals"] = comparison["county_fatals"].fillna(0)

    # Identify state-year combinations with different totals.
    mismatches = comparison[
        comparison["fatals"] != comparison["county_fatals"]
    ]

    print("\nState vs County Fatality Validation")
    print("----------------------------------")
    print(f"State-year records checked: {len(comparison):,}")
    print(f"Records with different totals: {len(mismatches)}")

    if not mismatches.empty:
        print("\nSample differences:")
        print(
            mismatches[
                ["year", "state", "fatals", "county_fatals"]
            ].head(10).to_string(index=False)
        )

    # Measure fatalities included in state totals but not county totals.
    comparison["fatality_difference"] = (
        comparison["fatals"] - comparison["county_fatals"]
    )

    print(
        f"Total difference in fatalities: "
        f"{comparison['fatality_difference'].sum():,.0f}"
    )

    print(
        f"Records where county totals exceed state totals: "
        f"{(comparison['fatality_difference'] < 0).sum()}"
    )


    # Summarize differences by year to identify when county totals are incomplete.
    yearly_differences = (
        comparison.groupby("year")["fatality_difference"]
        .sum()
    )

    print("\nState-county fatality differences by year:")
    print(
        yearly_differences[yearly_differences != 0].to_string()
    )

if __name__ == "__main__":
    check_county_data()
    check_state_county_totals()