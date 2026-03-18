import pandas as pd
import matplotlib.pyplot as plt
import sys
import os

def plot_stock_line(csv_file, symbol, start_date, end_date):
    date_format = "%Y-%m-%d"
    try:
        df = pd.read_csv(csv_file, parse_dates=['date'])
        df.set_index('date', inplace=True)

        start_date = pd.to_datetime(start_date, format=date_format)
        end_date = pd.to_datetime(end_date, format=date_format)

        df_filtered = df[(df.index >= start_date) & (df.index <= end_date)]

        if df_filtered.empty:
            raise ValueError(f"No data available for {symbol} between {start_date.date()} and {end_date.date()}")

        plt.figure(figsize=(10, 5))
        plt.plot(df_filtered.index, df_filtered['close'], marker='o', linestyle='-', color='b', label='Close Price')
        plt.title(f'{symbol} Stock Prices from {start_date.date()} to {end_date.date()}')
        plt.xlabel('Date')
        plt.ylabel('Price')
        plt.legend()
        plt.grid(True)
        plt.xticks(rotation=45)
        plt.tight_layout()

        if not os.path.exists('public'):
            os.makedirs('public')

        plot_path = os.path.join('public', 'stock_plot.png')
        plt.savefig(plot_path)
        plt.close()
        print("Plot saved as public/stock_plot.png")

    except Exception as e:
        print(f"Error: {e}")

if __name__ == '__main__':
    csv_file = sys.argv[1]
    symbol = sys.argv[2]
    start_date = sys.argv[3]
    end_date = sys.argv[4]
    
    try:
        plot_stock_line(csv_file, symbol, start_date, end_date)
    except Exception as e:
        print(f"Error: {e}")
